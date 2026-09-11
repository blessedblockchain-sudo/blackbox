//! The crank-driven core loop.
//!
//! `tick_clock`   advances the round's tick counter (one crank task per round).
//! `tick_entrant` refreshes market indicators from the oracle if this tick has
//!                not been seen yet, runs the entrant's private strategy in the
//!                VM, applies its trades to the private Position, marks equity,
//!                liquidates if needed and updates the scoreboard.
//!
//! Both are scheduled on MagicBlock's Native Crank inside the (TEE) ER.
//! `tick_entrant` accounts: round, scoreboard, entrant, strategy, position,
//! then remaining = [market_0, feed_0, market_1, feed_1, ...].
//!
//! All large accounts are zero-copy (`AccountLoader`), so nothing big is ever
//! copied onto the 4 KB SBF stack.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_lang::InstructionData;
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use magicblock_magic_program_api::{args::ScheduleTaskArgs, instruction::MagicBlockInstruction};

use crate::constants::*;
use crate::errors::BlackboxError;
use crate::oracle;
use crate::perps;
use crate::state::*;
use crate::vm_host::TickHost;

/// Funding accrues every this many ticks; rate at full skew in bps per period.
pub const FUNDING_PERIOD_TICKS: u64 = 240;
pub const FUNDING_RATE_BPS_AT_FULL_SKEW: i32 = 10;

// ------------------------------------------------------------ tick_clock

#[derive(Accounts)]
pub struct TickClock<'info> {
    /// CHECK: raw-deserialized (crank pattern)
    #[account(mut, owner = crate::ID)]
    pub round: UncheckedAccount<'info>,
}

pub fn tick_clock(ctx: Context<TickClock>) -> Result<()> {
    let info = ctx.accounts.round.to_account_info();
    let mut r = {
        let d = info.try_borrow_data()?;
        Round::try_deserialize(&mut &d[..])?
    };
    if !r.live {
        return Ok(());
    }
    r.tick = r.tick.saturating_add(1);
    if r.tick >= r.duration_ticks {
        // Time is up: freeze trading. Settlement instructions take over.
        r.live = false;
        r.status = RoundStatus::Settling;
        r.ended_at = Clock::get()?.unix_timestamp;
    }
    let mut d = info.try_borrow_mut_data()?;
    r.try_serialize(&mut &mut d[..])?;
    Ok(())
}

// ------------------------------------------------------------ tick_entrant

#[derive(Accounts)]
pub struct TickEntrant<'info> {
    /// CHECK: raw-deserialized (crank pattern)
    #[account(mut, owner = crate::ID)]
    pub round: UncheckedAccount<'info>,
    #[account(mut)]
    pub scoreboard: AccountLoader<'info, Scoreboard>,
    /// CHECK: raw-deserialized
    #[account(mut, owner = crate::ID)]
    pub entrant: UncheckedAccount<'info>,
    /// Private strategy (read-only here).
    pub strategy: AccountLoader<'info, Strategy>,
    /// Private position.
    #[account(mut)]
    pub position: AccountLoader<'info, Position>,
    // remaining_accounts: [market_0, feed_0, market_1, feed_1, ...]
}

pub fn tick_entrant<'info>(ctx: Context<'info, TickEntrant<'info>>) -> Result<()> {
    let round_info = ctx.accounts.round.to_account_info();
    let mut round = {
        let d = round_info.try_borrow_data()?;
        Round::try_deserialize(&mut &d[..])?
    };
    if !round.live {
        return Ok(());
    }
    let round_key = round_info.key();
    let n = round.n_markets as usize;
    require!(ctx.remaining_accounts.len() >= 2 * n, BlackboxError::BadMarketIndex);
    let now = Clock::get()?.unix_timestamp;
    let tick = round.tick;

    // 1) Markets: refresh indicators once per tick (first entrant to arrive does it).
    let mut loaders: Vec<AccountLoader<'info, Market>> = Vec::with_capacity(n);
    for i in 0..n {
        let m_info = &ctx.remaining_accounts[2 * i];
        let f_info = &ctx.remaining_accounts[2 * i + 1];
        let loader = AccountLoader::<Market>::try_from(m_info)?;
        {
            let mut m = loader.load_mut()?;
            require_keys_eq!(m.round, round_key, BlackboxError::RoundMismatch);
            require!(m.index as usize == i, BlackboxError::BadMarketIndex);
            if m.last_tick < tick || m.mark == 0 {
                let feed = m.feed;
                let decimals = m.decimals;
                let px = oracle::read_price(f_info, &feed, decimals, now)?;
                perps::update_indicators(&mut m, px.price, tick, px.publish_time)?;
                if tick > 0 && tick % FUNDING_PERIOD_TICKS == 0 && m.last_funding_tick < tick {
                    perps::accrue_funding(&mut m, FUNDING_RATE_BPS_AT_FULL_SKEW)?;
                    m.last_funding_tick = tick;
                }
            }
        }
        loaders.push(loader);
    }
    let mut ms: Vec<std::cell::RefMut<Market>> = Vec::with_capacity(n);
    for l in loaders.iter() {
        ms.push(l.load_mut()?);
    }

    // 2) Entrant + private state.
    let entrant_info = ctx.accounts.entrant.to_account_info();
    let mut entrant = {
        let d = entrant_info.try_borrow_data()?;
        Entrant::try_deserialize(&mut &d[..])?
    };
    require_keys_eq!(entrant.round, round_key, BlackboxError::RoundMismatch);
    let strategy = ctx.accounts.strategy.load()?;
    let mut pos_ref = ctx.accounts.position.load_mut()?;
    let position: &mut Position = &mut pos_ref;
    require_keys_eq!(position.owner, entrant.owner, BlackboxError::OwnerMismatch);
    require_keys_eq!(strategy.owner, entrant.owner, BlackboxError::OwnerMismatch);
    require_keys_eq!(position.round, round_key, BlackboxError::RoundMismatch);

    let mut marks = [0i64; MAX_MARKETS];
    let mut findex = [0i64; MAX_MARKETS];
    let mut maint = [0u16; MAX_MARKETS];
    for i in 0..n {
        marks[i] = ms[i].mark;
        findex[i] = ms[i].funding_index;
        maint[i] = ms[i].maintenance_bps;
    }

    let mut equity = perps::equity(position.margin, position.realized_pnl, &position.legs, &marks, &findex)?;

    // 3) Run the strategy (only if alive, funded, and it has code).
    if entrant.alive && position.liquidated == 0 && position.margin > 0 && strategy.len > 0 {
        // Free margin = equity - Σ size_i / max_leverage_i (initial margin in use).
        let mut used: i128 = 0;
        for i in 0..n {
            if position.legs[i].side != 0 {
                used += position.legs[i].size as i128 / (ms[i].max_leverage.max(1) as i128);
            }
        }
        let free = (equity as i128 - used).clamp(0, i64::MAX as i128) as i64;
        let res = {
            let refs: Vec<&Market> = ms.iter().map(|m| &**m).collect();
            let host = TickHost {
                markets: &refs,
                legs: &position.legs,
                equity,
                free_margin: free,
                tick,
                rand: TickHost::derive_rand(&round.vrf_seed, &entrant.owner, tick),
            };
            let step_limit = strategy.step_limit.min(round.step_limit).max(1);
            bxvm::execute(&strategy.bytecode[..strategy.len as usize], &host, &mut position.mem, step_limit)
        };
        position.last_steps = res.steps;
        if let Some(f) = res.fault {
            position.last_fault = f as u8 + 1;
            position.last_fault_pc = res.pc;
        } else {
            position.last_fault = 0;
            position.last_fault_pc = 0;
            for action in res.actions() {
                apply_action(action, &mut ms, position, equity, n)?;
                equity = perps::equity(position.margin, position.realized_pnl, &position.legs, &marks, &findex)?;
            }
        }
    }

    // 4) Mark to market, maintenance check, liquidation.
    equity = perps::equity(position.margin, position.realized_pnl, &position.legs, &marks, &findex)?;
    let (_, maint_req) = perps::notional_and_maintenance(&position.legs, &maint);
    if position.liquidated == 0 && position.margin > 0 && (equity as i128) < maint_req {
        for i in 0..n {
            if position.legs[i].side != 0 {
                let r = perps::trade_to_target(&mut ms[i], &mut position.legs[i], 0, equity, 0)?;
                position.realized_pnl = position.realized_pnl.saturating_add(r.realized_delta);
            }
        }
        equity = perps::equity(position.margin, position.realized_pnl, &position.legs, &marks, &findex)?;
        position.liquidated = 1;
        entrant.alive = false;
        if equity < 0 {
            // Vault absorbs the shortfall.
            position.realized_pnl = -(position.margin as i64);
            equity = 0;
        }
    }

    // 5) Rolling Sharpe accumulators (per-tick return, scaled).
    if position.last_equity > 0 {
        let r = ((equity as i128 - position.last_equity as i128) * USDC_SCALE as i128 / position.last_equity as i128) as i64;
        position.sum_ret = position.sum_ret.saturating_add(r);
        position.sum_ret_sq = position.sum_ret_sq.saturating_add(((r as i128 * r as i128) / USDC_SCALE as i128) as i64);
        position.ret_n = position.ret_n.saturating_add(1);
    }
    position.last_equity = equity;
    if equity > position.peak_equity {
        position.peak_equity = equity;
    }
    let trades = position.trade_count;
    drop(pos_ref);
    drop(strategy);
    drop(ms);

    // 6) Persist the entrant.
    {
        let mut d = entrant_info.try_borrow_mut_data()?;
        entrant.try_serialize(&mut &mut d[..])?;
    }

    // 7) Scoreboard: public equity, alive, trades (no positions, no code).
    {
        let mut sb = ctx.accounts.scoreboard.load_mut()?;
        require_keys_eq!(sb.round, round_key, BlackboxError::RoundMismatch);
        let idx = entrant.index as usize;
        require!(idx < MAX_ENTRANTS, BlackboxError::ScoreboardFull);
        if (sb.n as usize) <= idx {
            sb.n = (idx + 1) as u16;
        }
        let e = &mut sb.entries[idx];
        e.owner = entrant.owner;
        e.equity = equity;
        e.deposited = entrant.deposited;
        e.alive = entrant.alive as u8;
        e.trades = trades;
        let mut total: i128 = 0;
        for e in sb.entries.iter().take(sb.n as usize) {
            total += e.equity as i128;
        }
        round.total_equity = total.clamp(i64::MIN as i128, i64::MAX as i128) as i64;
    }
    {
        let mut d = round_info.try_borrow_mut_data()?;
        round.try_serialize(&mut &mut d[..])?;
    }
    Ok(())
}

/// Apply one VM action to the position. Rejected increases (leverage or OI
/// cap) are skipped; they never fault the tick.
fn apply_action(
    action: bxvm::Action,
    ms: &mut [std::cell::RefMut<Market>],
    position: &mut Position,
    equity: i64,
    n: usize,
) -> Result<()> {
    let mut levs = [1i128; MAX_MARKETS];
    for (i, m) in ms.iter().enumerate().take(n) {
        levs[i] = m.max_leverage.max(1) as i128;
    }
    let mut trade = |i: usize, target: i128, position: &mut Position| -> Result<()> {
        let other = other_notional(&position.legs, i);
        match perps::trade_to_target(&mut ms[i], &mut position.legs[i], target, equity, other) {
            Ok(r) => {
                position.realized_pnl = position.realized_pnl.saturating_add(r.realized_delta);
                if r.traded {
                    position.trade_count = position.trade_count.saturating_add(1);
                }
                Ok(())
            }
            Err(e) if target == 0 => Err(e),
            Err(_) => Ok(()),
        }
    };
    match action {
        bxvm::Action::CloseAll => {
            for i in 0..n {
                if position.legs[i].side != 0 {
                    trade(i, 0, position)?;
                }
            }
        }
        bxvm::Action::Close { market } => {
            let i = market as usize;
            if i < n && position.legs[i].side != 0 {
                trade(i, 0, position)?;
            }
        }
        bxvm::Action::Long { market, size_bps } | bxvm::Action::Short { market, size_bps } => {
            let i = market as usize;
            if i < n {
                // size_bps is a fraction of buying power: 10_000 = equity * max_leverage.
                let sign: i128 = if matches!(action, bxvm::Action::Long { .. }) { 1 } else { -1 };
                let target = (equity.max(0) as i128 * levs[i] * size_bps as i128 / BPS as i128) * sign;
                trade(i, target, position)?;
            }
        }
    }
    Ok(())
}

fn other_notional(legs: &[Leg; MAX_MARKETS], except: usize) -> i128 {
    let mut s: i128 = 0;
    for (i, l) in legs.iter().enumerate() {
        if i != except && l.side != 0 {
            s += l.size as i128;
        }
    }
    s
}

// ------------------------------------------------------------ scheduling (ER)

pub(crate) fn schedule<'info>(
    payer: &AccountInfo<'info>,
    magic_program: &AccountInfo<'info>,
    task_id: i64,
    interval_ms: i64,
    iterations: i64,
    inner: Instruction,
    inner_infos: &[AccountInfo<'info>],
) -> Result<()> {
    let metas_inner = inner.accounts.clone();
    let args = ScheduleTaskArgs { task_id, execution_interval_millis: interval_ms, iterations, instructions: vec![inner] };
    let data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(args)).map_err(|_| error!(BlackboxError::SerializeFailed))?;
    let mut metas = vec![AccountMeta::new(payer.key(), true), AccountMeta::new(payer.key(), true)];
    metas.extend(metas_inner);
    let ix = Instruction { program_id: MAGIC_PROGRAM_ID, accounts: metas, data };
    let mut infos: Vec<AccountInfo<'info>> = vec![payer.clone(), payer.clone()];
    infos.extend(inner_infos.iter().cloned());
    infos.push(magic_program.clone());
    invoke(&ix, &infos)?;
    Ok(())
}

#[derive(Accounts)]
pub struct ScheduleClock<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump, has_one = admin)]
    pub round: Account<'info, Round>,
    /// CHECK: magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

/// Schedule the round clock: one `tick_clock` per `tick_interval_ms` for the
/// whole duration. Call right after `start_round` (on the ER).
pub fn schedule_clock(ctx: Context<ScheduleClock>, task_id: i64) -> Result<()> {
    let r = &ctx.accounts.round;
    require!(r.status == RoundStatus::Live, BlackboxError::NotLive);
    let inner = Instruction {
        program_id: crate::ID,
        accounts: vec![AccountMeta::new(r.key(), false)],
        data: crate::instruction::TickClock {}.data(),
    };
    schedule(
        &ctx.accounts.admin.to_account_info(),
        &ctx.accounts.magic_program.to_account_info(),
        task_id,
        r.tick_interval_ms as i64,
        r.duration_ticks as i64 + 1,
        inner,
        &[ctx.accounts.round.to_account_info()],
    )
}

#[derive(Accounts)]
pub struct ScheduleEntrantTick<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Writable: the scheduled tick writes it, and a CPI cannot escalate privileges.
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: scoreboard PDA (only its key is needed)
    #[account(mut, seeds = [SCOREBOARD_SEED, round.key().as_ref()], bump)]
    pub scoreboard: UncheckedAccount<'info>,
    #[account(mut, seeds = [ENTRANT_SEED, round.key().as_ref(), entrant.owner.as_ref()], bump = entrant.bump)]
    pub entrant: Box<Account<'info, Entrant>>,
    /// CHECK: strategy PDA (private; only its key is needed here)
    #[account(seeds = [STRATEGY_SEED, round.key().as_ref(), entrant.owner.as_ref()], bump)]
    pub strategy: UncheckedAccount<'info>,
    /// CHECK: position PDA
    #[account(mut, seeds = [POSITION_SEED, round.key().as_ref(), entrant.owner.as_ref()], bump)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    // remaining_accounts: [market_0, feed_0, ...] in round order
}

/// Schedule `tick_entrant` for one entrant for the rest of the round.
/// Callable by the entrant (or anyone willing to pay) once the round is live.
pub fn schedule_entrant_tick<'info>(ctx: Context<'info, ScheduleEntrantTick<'info>>, task_id: i64) -> Result<()> {
    let r = &ctx.accounts.round;
    require!(r.status == RoundStatus::Live, BlackboxError::NotLive);
    let n = r.n_markets as usize;
    require!(ctx.remaining_accounts.len() == 2 * n, BlackboxError::BadMarketIndex);
    let round_key = r.key();
    for i in 0..n {
        let (expected_market, _) = Pubkey::find_program_address(&[MARKET_SEED, round_key.as_ref(), &[i as u8]], &crate::ID);
        require_keys_eq!(ctx.remaining_accounts[2 * i].key(), expected_market, BlackboxError::BadMarketIndex);
        require_keys_eq!(ctx.remaining_accounts[2 * i + 1].key(), r.markets[i].feed, BlackboxError::BadOracle);
    }
    let mut metas = vec![
        AccountMeta::new(round_key, false),
        AccountMeta::new(ctx.accounts.scoreboard.key(), false),
        AccountMeta::new(ctx.accounts.entrant.key(), false),
        AccountMeta::new_readonly(ctx.accounts.strategy.key(), false),
        AccountMeta::new(ctx.accounts.position.key(), false),
    ];
    let mut infos: Vec<AccountInfo<'info>> = vec![
        ctx.accounts.round.to_account_info(),
        ctx.accounts.scoreboard.to_account_info(),
        ctx.accounts.entrant.to_account_info(),
        ctx.accounts.strategy.to_account_info(),
        ctx.accounts.position.to_account_info(),
    ];
    for i in 0..n {
        metas.push(AccountMeta::new(ctx.remaining_accounts[2 * i].key(), false));
        metas.push(AccountMeta::new_readonly(ctx.remaining_accounts[2 * i + 1].key(), false));
        infos.push(ctx.remaining_accounts[2 * i].clone());
        infos.push(ctx.remaining_accounts[2 * i + 1].clone());
    }
    let inner = Instruction { program_id: crate::ID, accounts: metas, data: crate::instruction::TickEntrant {}.data() };
    let remaining = r.duration_ticks.saturating_sub(r.tick) as i64 + 1;
    schedule(
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.magic_program.to_account_info(),
        task_id,
        r.tick_interval_ms as i64,
        remaining.max(1),
        inner,
        &infos,
    )
}
