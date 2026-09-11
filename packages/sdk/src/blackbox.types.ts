/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/blackbox.json`.
 */
export type Blackbox = {
  "address": "BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27",
  "metadata": {
    "name": "blackbox",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "BLACKBOX: strategies executed inside a MagicBlock Private Ephemeral Rollup. Alpha you can't read."
  },
  "instructions": [
    {
      "name": "activateLicense",
      "discriminator": [
        165,
        114,
        199,
        175,
        231,
        240,
        48,
        63
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "docs": [
            "Writable: activation counts the license in `open_licenses`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "authorEntrant",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "authorEntrant.owner",
                "account": "entrant"
              }
            ]
          }
        },
        {
          "name": "license",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  99
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "buyer"
              },
              {
                "kind": "account",
                "path": "authorEntrant.owner",
                "account": "entrant"
              }
            ]
          }
        },
        {
          "name": "permission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "license"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "buyerAta",
          "writable": true
        },
        {
          "name": "custodyAta",
          "writable": true
        },
        {
          "name": "permissionProgram",
          "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
        },
        {
          "name": "ephemeralVault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "margin",
          "type": "u64"
        }
      ]
    },
    {
      "name": "addMarket",
      "discriminator": [
        41,
        137,
        185,
        126,
        69,
        139,
        254,
        55
      ],
      "accounts": [
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "feed",
          "docs": [
            "is owned by the delegation program)."
          ]
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "round"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "index",
          "type": "u8"
        },
        {
          "name": "cfg",
          "type": {
            "defined": {
              "name": "marketConfig"
            }
          }
        }
      ]
    },
    {
      "name": "closeChat",
      "discriminator": [
        182,
        227,
        125,
        158,
        213,
        132,
        147,
        192
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "round"
          ]
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "chat",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  104,
                  97,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "closeRound",
      "discriminator": [
        149,
        14,
        81,
        88,
        230,
        226,
        234,
        37
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "scoreboard",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  97,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        },
        {
          "name": "magicContext",
          "writable": true,
          "address": "MagicContext1111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "createRound",
      "discriminator": [
        229,
        218,
        236,
        169,
        231,
        80,
        134,
        112
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "config.roundCount",
                "account": "protocolConfig"
              }
            ]
          }
        },
        {
          "name": "scoreboard",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  97,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "vaultAta",
          "docs": [
            "The round's custody token account (vault + pot), owned by the Round PDA."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vaultEata",
          "writable": true
        },
        {
          "name": "eataBuffer",
          "writable": true
        },
        {
          "name": "eataRecord",
          "writable": true
        },
        {
          "name": "eataMetadata",
          "writable": true
        },
        {
          "name": "ephemeralTokenProgram",
          "address": "SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "validator"
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createRoundArgs"
            }
          }
        }
      ]
    },
    {
      "name": "delegateEntrant",
      "discriminator": [
        165,
        82,
        48,
        99,
        133,
        72,
        175,
        30
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "round"
        },
        {
          "name": "bufferEntrant",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "entrant"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                156,
                79,
                37,
                80,
                36,
                72,
                1,
                174,
                233,
                191,
                181,
                191,
                93,
                211,
                214,
                142,
                12,
                167,
                199,
                177,
                204,
                213,
                34,
                101,
                73,
                123,
                102,
                208,
                174,
                84,
                247,
                124
              ]
            }
          }
        },
        {
          "name": "delegationRecordEntrant",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "entrant"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataEntrant",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "entrant"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "entrant",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "bufferStrategy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "strategy"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                156,
                79,
                37,
                80,
                36,
                72,
                1,
                174,
                233,
                191,
                181,
                191,
                93,
                211,
                214,
                142,
                12,
                167,
                199,
                177,
                204,
                213,
                34,
                101,
                73,
                123,
                102,
                208,
                174,
                84,
                247,
                124
              ]
            }
          }
        },
        {
          "name": "delegationRecordStrategy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "strategy"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataStrategy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "strategy"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "strategy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "bufferPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                156,
                79,
                37,
                80,
                36,
                72,
                1,
                174,
                233,
                191,
                181,
                191,
                93,
                211,
                214,
                142,
                12,
                167,
                199,
                177,
                204,
                213,
                34,
                101,
                73,
                123,
                102,
                208,
                174,
                84,
                247,
                124
              ]
            }
          }
        },
        {
          "name": "delegationRecordPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "validator"
        },
        {
          "name": "ownerProgram",
          "address": "BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "delegateLicense",
      "discriminator": [
        39,
        76,
        13,
        212,
        154,
        121,
        234,
        185
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "round"
        },
        {
          "name": "author"
        },
        {
          "name": "bufferLicense",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "license"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                156,
                79,
                37,
                80,
                36,
                72,
                1,
                174,
                233,
                191,
                181,
                191,
                93,
                211,
                214,
                142,
                12,
                167,
                199,
                177,
                204,
                213,
                34,
                101,
                73,
                123,
                102,
                208,
                174,
                84,
                247,
                124
              ]
            }
          }
        },
        {
          "name": "delegationRecordLicense",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "license"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataLicense",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "license"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "license",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  99
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "buyer"
              },
              {
                "kind": "account",
                "path": "author"
              }
            ]
          }
        },
        {
          "name": "validator"
        },
        {
          "name": "ownerProgram",
          "address": "BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "delegateMarket",
      "discriminator": [
        223,
        125,
        110,
        148,
        99,
        176,
        143,
        72
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "arg",
                "path": "roundId"
              }
            ]
          }
        },
        {
          "name": "bufferMarket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                156,
                79,
                37,
                80,
                36,
                72,
                1,
                174,
                233,
                191,
                181,
                191,
                93,
                211,
                214,
                142,
                12,
                167,
                199,
                177,
                204,
                213,
                34,
                101,
                73,
                123,
                102,
                208,
                174,
                84,
                247,
                124
              ]
            }
          }
        },
        {
          "name": "delegationRecordMarket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataMarket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "validator"
        },
        {
          "name": "ownerProgram",
          "address": "BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "roundId",
          "type": "u32"
        },
        {
          "name": "index",
          "type": "u8"
        }
      ]
    },
    {
      "name": "delegateMockFeed",
      "discriminator": [
        118,
        209,
        234,
        215,
        66,
        2,
        238,
        242
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "bufferFeed",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "feed"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                156,
                79,
                37,
                80,
                36,
                72,
                1,
                174,
                233,
                191,
                181,
                191,
                93,
                211,
                214,
                142,
                12,
                167,
                199,
                177,
                204,
                213,
                34,
                101,
                73,
                123,
                102,
                208,
                174,
                84,
                247,
                124
              ]
            }
          }
        },
        {
          "name": "delegationRecordFeed",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "feed"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataFeed",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "feed"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "feed",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  111,
                  99,
                  107,
                  102,
                  101,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              },
              {
                "kind": "arg",
                "path": "feedId"
              }
            ]
          }
        },
        {
          "name": "validator"
        },
        {
          "name": "ownerProgram",
          "address": "BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "feedId",
          "type": "u32"
        }
      ]
    },
    {
      "name": "delegateRound",
      "discriminator": [
        4,
        60,
        37,
        224,
        19,
        130,
        106,
        111
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "bufferRound",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                156,
                79,
                37,
                80,
                36,
                72,
                1,
                174,
                233,
                191,
                181,
                191,
                93,
                211,
                214,
                142,
                12,
                167,
                199,
                177,
                204,
                213,
                34,
                101,
                73,
                123,
                102,
                208,
                174,
                84,
                247,
                124
              ]
            }
          }
        },
        {
          "name": "delegationRecordRound",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataRound",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "arg",
                "path": "roundId"
              }
            ]
          }
        },
        {
          "name": "bufferScoreboard",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "scoreboard"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                156,
                79,
                37,
                80,
                36,
                72,
                1,
                174,
                233,
                191,
                181,
                191,
                93,
                211,
                214,
                142,
                12,
                167,
                199,
                177,
                204,
                213,
                34,
                101,
                73,
                123,
                102,
                208,
                174,
                84,
                247,
                124
              ]
            }
          }
        },
        {
          "name": "delegationRecordScoreboard",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "scoreboard"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataScoreboard",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "scoreboard"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "scoreboard",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  97,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "validator"
        },
        {
          "name": "ownerProgram",
          "address": "BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "roundId",
          "type": "u32"
        }
      ]
    },
    {
      "name": "fundEntrant",
      "discriminator": [
        164,
        28,
        6,
        89,
        188,
        75,
        13,
        95
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "entrant"
          ]
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "entrant",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "ownerAta",
          "docs": [
            "The user's delegated USDC (their ATA address on the ER)."
          ],
          "writable": true
        },
        {
          "name": "custodyAta",
          "docs": [
            "Entrant PDA custody (its ATA address on the ER)."
          ],
          "writable": true
        },
        {
          "name": "vaultAta",
          "docs": [
            "Round PDA vault (its ATA address on the ER)."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "margin",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initHall",
      "discriminator": [
        115,
        155,
        201,
        56,
        185,
        119,
        185,
        134
      ],
      "accounts": [
        {
          "name": "hall",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  97,
                  108,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "wallet"
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initMockFeed",
      "discriminator": [
        2,
        244,
        200,
        87,
        209,
        125,
        202,
        119
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "feed",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  111,
                  99,
                  107,
                  102,
                  101,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              },
              {
                "kind": "arg",
                "path": "feedId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "feedId",
          "type": "u32"
        },
        {
          "name": "rawPrice",
          "type": "i64"
        },
        {
          "name": "decimals",
          "type": "u8"
        }
      ]
    },
    {
      "name": "initProtocol",
      "discriminator": [
        3,
        188,
        141,
        237,
        225,
        226,
        232,
        210
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "protocolFeeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "joinRound",
      "discriminator": [
        191,
        222,
        86,
        25,
        234,
        174,
        157,
        249
      ],
      "accounts": [
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "entrant",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "strategy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "custodyAta",
          "docs": [
            "Custody token account owned by the Entrant PDA (margin lives here on the ER)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "entrant"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "custodyEata",
          "writable": true
        },
        {
          "name": "eataBuffer",
          "writable": true
        },
        {
          "name": "eataRecord",
          "writable": true
        },
        {
          "name": "eataMetadata",
          "writable": true
        },
        {
          "name": "ephemeralTokenProgram",
          "address": "SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "openLicense",
      "discriminator": [
        0,
        194,
        190,
        66,
        30,
        82,
        33,
        57
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "round"
        },
        {
          "name": "authorEntrant"
        },
        {
          "name": "license",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  99
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "buyer"
              },
              {
                "kind": "account",
                "path": "author"
              }
            ]
          }
        },
        {
          "name": "author"
        },
        {
          "name": "mint"
        },
        {
          "name": "custodyAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "license"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "custodyEata",
          "writable": true
        },
        {
          "name": "eataBuffer",
          "writable": true
        },
        {
          "name": "eataRecord",
          "writable": true
        },
        {
          "name": "eataMetadata",
          "writable": true
        },
        {
          "name": "ephemeralTokenProgram",
          "address": "SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "openRound",
      "discriminator": [
        66,
        235,
        123,
        240,
        8,
        35,
        185,
        159
      ],
      "accounts": [
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "round"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "payPrizes",
      "discriminator": [
        95,
        250,
        235,
        14,
        16,
        247,
        64,
        251
      ],
      "accounts": [
        {
          "name": "payer",
          "signer": true
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "scoreboard",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  97,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "vaultAta",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "postChat",
      "discriminator": [
        47,
        231,
        147,
        123,
        37,
        236,
        132,
        171
      ],
      "accounts": [
        {
          "name": "author",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "docs": [
            "Sponsor of the chat account (debited once, refunded by close_chat)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "chat",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  104,
                  97,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "text",
          "type": "string"
        }
      ]
    },
    {
      "name": "privatizeEntrant",
      "discriminator": [
        59,
        163,
        155,
        137,
        210,
        77,
        30,
        105
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "entrant"
          ]
        },
        {
          "name": "round",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "entrant",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "strategy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "strategyPermission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "strategy"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "positionPermission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "permissionProgram",
          "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
        },
        {
          "name": "ephemeralVault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "processUndelegation",
      "discriminator": [
        196,
        28,
        41,
        206,
        48,
        37,
        51,
        167
      ],
      "accounts": [
        {
          "name": "baseAccount",
          "writable": true
        },
        {
          "name": "buffer",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  110,
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  101,
                  45,
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "baseAccount"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                181,
                183,
                0,
                225,
                242,
                87,
                58,
                192,
                204,
                6,
                34,
                1,
                52,
                74,
                207,
                151,
                184,
                53,
                6,
                235,
                140,
                229,
                25,
                152,
                204,
                98,
                126,
                24,
                147,
                128,
                167,
                62
              ]
            }
          }
        },
        {
          "name": "payer",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "accountSeeds",
          "type": {
            "vec": "bytes"
          }
        }
      ]
    },
    {
      "name": "rankRound",
      "discriminator": [
        208,
        220,
        63,
        86,
        63,
        239,
        184,
        237
      ],
      "accounts": [
        {
          "name": "payer",
          "signer": true
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "scoreboard",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  97,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "recordHall",
      "discriminator": [
        214,
        225,
        204,
        227,
        113,
        82,
        179,
        204
      ],
      "accounts": [
        {
          "name": "round",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "scoreboard",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  97,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "hall",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  97,
                  108,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "hall.wallet",
                "account": "hall"
              }
            ]
          }
        },
        {
          "name": "entrant",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "hall.wallet",
                "account": "hall"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "requestRoundSeed",
      "discriminator": [
        228,
        76,
        146,
        186,
        12,
        30,
        244,
        166
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "oracleQueue",
          "writable": true
        },
        {
          "name": "programIdentity",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  100,
                  101,
                  110,
                  116,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "vrfProgram",
          "address": "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz"
        },
        {
          "name": "slotHashes",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "clientSeed",
          "type": "u8"
        }
      ]
    },
    {
      "name": "roundSeedCallback",
      "discriminator": [
        168,
        118,
        14,
        48,
        47,
        43,
        151,
        37
      ],
      "accounts": [
        {
          "name": "vrfProgramIdentity",
          "docs": [
            "Scoped VRF identity PDA, bound to this program. Its presence as a signer proves",
            "the callback was issued by the VRF program for this program."
          ],
          "signer": true
        },
        {
          "name": "round",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "randomness",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "clientSeed",
          "type": "u8"
        }
      ]
    },
    {
      "name": "scheduleClock",
      "discriminator": [
        161,
        194,
        7,
        234,
        209,
        168,
        29,
        190
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "round"
          ]
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "taskId",
          "type": "i64"
        }
      ]
    },
    {
      "name": "scheduleEntrantTick",
      "discriminator": [
        242,
        209,
        235,
        119,
        83,
        110,
        153,
        251
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "docs": [
            "Writable: the scheduled tick writes it, and a CPI cannot escalate privileges."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "scoreboard",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  97,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "entrant",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "entrant.owner",
                "account": "entrant"
              }
            ]
          }
        },
        {
          "name": "strategy",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "entrant.owner",
                "account": "entrant"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "entrant.owner",
                "account": "entrant"
              }
            ]
          }
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "taskId",
          "type": "i64"
        }
      ]
    },
    {
      "name": "scheduleLicenseTick",
      "discriminator": [
        120,
        20,
        194,
        54,
        43,
        97,
        193,
        186
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "authorEntrant",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "authorEntrant.owner",
                "account": "entrant"
              }
            ]
          }
        },
        {
          "name": "strategy",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "authorEntrant.owner",
                "account": "entrant"
              }
            ]
          }
        },
        {
          "name": "license",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  99
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "buyer"
              },
              {
                "kind": "account",
                "path": "authorEntrant.owner",
                "account": "entrant"
              }
            ]
          }
        },
        {
          "name": "buyer"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "taskId",
          "type": "i64"
        }
      ]
    },
    {
      "name": "seedVault",
      "discriminator": [
        181,
        183,
        221,
        107,
        162,
        110,
        142,
        222
      ],
      "accounts": [
        {
          "name": "funder",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "funderAta",
          "docs": [
            "The funder's USDC on the ER (their ATA address)."
          ],
          "writable": true
        },
        {
          "name": "vaultAta",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setMockFeed",
      "discriminator": [
        250,
        124,
        87,
        39,
        22,
        98,
        55,
        115
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "feed",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "rawPrice",
          "type": "i64"
        },
        {
          "name": "decimals",
          "type": "u8"
        }
      ]
    },
    {
      "name": "setScoreboardPrivacy",
      "discriminator": [
        29,
        128,
        4,
        217,
        60,
        126,
        183,
        8
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "round"
          ]
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "scoreboard",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  97,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "permission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "scoreboard"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "permissionProgram",
          "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
        },
        {
          "name": "ephemeralVault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "private",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setStrategy",
      "discriminator": [
        251,
        41,
        210,
        173,
        140,
        96,
        78,
        235
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "entrant"
          ]
        },
        {
          "name": "round",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "entrant",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "strategy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "bytecode",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "settleEntrant",
      "discriminator": [
        110,
        132,
        16,
        11,
        118,
        216,
        159,
        97
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "scoreboard",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  97,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "entrant",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "entrant.owner",
                "account": "entrant"
              }
            ]
          }
        },
        {
          "name": "strategy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "entrant.owner",
                "account": "entrant"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "entrant.owner",
                "account": "entrant"
              }
            ]
          }
        },
        {
          "name": "ownerAta",
          "docs": [
            "The owner's USDC on the ER (their ATA address)."
          ],
          "writable": true
        },
        {
          "name": "custodyAta",
          "writable": true
        },
        {
          "name": "vaultAta",
          "writable": true
        },
        {
          "name": "strategyPermission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "strategy"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "positionPermission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "permissionProgram",
          "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
        },
        {
          "name": "ephemeralVault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "settleLicense",
      "discriminator": [
        193,
        187,
        151,
        181,
        228,
        193,
        176,
        190
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "license",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  99
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "buyer"
              },
              {
                "kind": "account",
                "path": "author"
              }
            ]
          }
        },
        {
          "name": "buyer"
        },
        {
          "name": "author"
        },
        {
          "name": "custodyAta",
          "writable": true
        },
        {
          "name": "vaultAta",
          "writable": true
        },
        {
          "name": "buyerAta",
          "writable": true
        },
        {
          "name": "authorAta",
          "writable": true
        },
        {
          "name": "permission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "license"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "permissionProgram",
          "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
        },
        {
          "name": "ephemeralVault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "startRound",
      "discriminator": [
        144,
        144,
        43,
        7,
        193,
        42,
        217,
        215
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "round"
          ]
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "sweepVault",
      "discriminator": [
        137,
        92,
        9,
        1,
        140,
        237,
        214,
        140
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "round"
          ]
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "toAta",
          "docs": [
            "Destination chosen by the admin (on the ER), e.g. the house wallet's ATA."
          ],
          "writable": true
        },
        {
          "name": "vaultAta",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "tickClock",
      "discriminator": [
        201,
        57,
        21,
        127,
        126,
        77,
        221,
        236
      ],
      "accounts": [
        {
          "name": "round",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "tickEntrant",
      "discriminator": [
        124,
        194,
        134,
        67,
        94,
        163,
        37,
        102
      ],
      "accounts": [
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "scoreboard",
          "writable": true
        },
        {
          "name": "entrant",
          "writable": true
        },
        {
          "name": "strategy",
          "docs": [
            "Private strategy (read-only here)."
          ]
        },
        {
          "name": "position",
          "docs": [
            "Private position."
          ],
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "tickLicense",
      "discriminator": [
        139,
        183,
        220,
        204,
        241,
        168,
        208,
        241
      ],
      "accounts": [
        {
          "name": "round"
        },
        {
          "name": "authorEntrant"
        },
        {
          "name": "strategy",
          "docs": [
            "The author's private strategy: read by the program, never by the buyer."
          ]
        },
        {
          "name": "license",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "undelegateEntrant",
      "discriminator": [
        173,
        150,
        108,
        158,
        116,
        164,
        59,
        250
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "entrant",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "entrant.owner",
                "account": "entrant"
              }
            ]
          }
        },
        {
          "name": "strategy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "entrant.owner",
                "account": "entrant"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "entrant.owner",
                "account": "entrant"
              }
            ]
          }
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        },
        {
          "name": "magicContext",
          "writable": true,
          "address": "MagicContext1111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "undelegateLicense",
      "discriminator": [
        216,
        7,
        81,
        250,
        96,
        138,
        252,
        12
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "license",
          "writable": true
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        },
        {
          "name": "magicContext",
          "writable": true,
          "address": "MagicContext1111111111111111111111111111111"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "entrant",
      "discriminator": [
        64,
        36,
        220,
        184,
        151,
        231,
        35,
        210
      ]
    },
    {
      "name": "hall",
      "discriminator": [
        187,
        199,
        90,
        26,
        91,
        128,
        153,
        206
      ]
    },
    {
      "name": "license",
      "discriminator": [
        248,
        152,
        195,
        100,
        185,
        108,
        176,
        231
      ]
    },
    {
      "name": "market",
      "discriminator": [
        219,
        190,
        213,
        55,
        0,
        227,
        198,
        154
      ]
    },
    {
      "name": "position",
      "discriminator": [
        170,
        188,
        143,
        228,
        122,
        64,
        247,
        208
      ]
    },
    {
      "name": "protocolConfig",
      "discriminator": [
        207,
        91,
        250,
        28,
        152,
        179,
        215,
        209
      ]
    },
    {
      "name": "round",
      "discriminator": [
        87,
        127,
        165,
        51,
        73,
        78,
        116,
        174
      ]
    },
    {
      "name": "scoreboard",
      "discriminator": [
        169,
        90,
        242,
        177,
        38,
        55,
        110,
        101
      ]
    },
    {
      "name": "strategy",
      "discriminator": [
        174,
        110,
        39,
        119,
        82,
        106,
        169,
        102
      ]
    }
  ],
  "events": [
    {
      "name": "licenseSettled",
      "discriminator": [
        14,
        158,
        13,
        21,
        211,
        191,
        114,
        65
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "paused",
      "msg": "protocol is paused"
    },
    {
      "code": 6001,
      "name": "unauthorized",
      "msg": "unauthorized"
    },
    {
      "code": 6002,
      "name": "mathOverflow",
      "msg": "math overflow"
    },
    {
      "code": 6003,
      "name": "badRoundStatus",
      "msg": "round is not in the expected status"
    },
    {
      "code": 6004,
      "name": "roundFull",
      "msg": "round is full"
    },
    {
      "code": 6005,
      "name": "badMarketIndex",
      "msg": "market index out of range"
    },
    {
      "code": 6006,
      "name": "marketExists",
      "msg": "market already configured"
    },
    {
      "code": 6007,
      "name": "badMarketConfig",
      "msg": "invalid market config"
    },
    {
      "code": 6008,
      "name": "badDeposit",
      "msg": "deposit outside [min_margin, max_margin]"
    },
    {
      "code": 6009,
      "name": "badBytecode",
      "msg": "strategy bytecode failed validation"
    },
    {
      "code": 6010,
      "name": "bytecodeTooLong",
      "msg": "strategy bytecode too long"
    },
    {
      "code": 6011,
      "name": "badOracle",
      "msg": "price feed account is invalid, stale, or for another feed"
    },
    {
      "code": 6012,
      "name": "badEata",
      "msg": "bad ephemeral ATA or delegation PDA"
    },
    {
      "code": 6013,
      "name": "permissionExists",
      "msg": "permission account already exists"
    },
    {
      "code": 6014,
      "name": "notDelegated",
      "msg": "account is not delegated or not on the expected validator"
    },
    {
      "code": 6015,
      "name": "serializeFailed",
      "msg": "failed to serialize instruction"
    },
    {
      "code": 6016,
      "name": "alreadyPrivatized",
      "msg": "entrant already privatized"
    },
    {
      "code": 6017,
      "name": "notLive",
      "msg": "round is not live"
    },
    {
      "code": 6018,
      "name": "roundMismatch",
      "msg": "wrong round for this account"
    },
    {
      "code": 6019,
      "name": "ownerMismatch",
      "msg": "wrong owner for this account"
    },
    {
      "code": 6020,
      "name": "badBatch",
      "msg": "batch index out of range"
    },
    {
      "code": 6021,
      "name": "insufficientMargin",
      "msg": "insufficient margin"
    },
    {
      "code": 6022,
      "name": "leverageExceeded",
      "msg": "position would exceed max leverage"
    },
    {
      "code": 6023,
      "name": "oiCap",
      "msg": "open interest cap reached"
    },
    {
      "code": 6024,
      "name": "licenseLimit",
      "msg": "license limit reached for this author"
    },
    {
      "code": 6025,
      "name": "licenseInactive",
      "msg": "license is not active"
    },
    {
      "code": 6026,
      "name": "scoreboardFull",
      "msg": "scoreboard is full"
    },
    {
      "code": 6027,
      "name": "notOnScoreboard",
      "msg": "entrant not found on scoreboard"
    },
    {
      "code": 6028,
      "name": "roundNotEnded",
      "msg": "round has not ended yet"
    },
    {
      "code": 6029,
      "name": "alreadyFinalized",
      "msg": "round already finalized"
    },
    {
      "code": 6030,
      "name": "crankInactive",
      "msg": "crank task guard: round not live"
    },
    {
      "code": 6031,
      "name": "vrfNotReady",
      "msg": "VRF randomness not ready"
    },
    {
      "code": 6032,
      "name": "badChat",
      "msg": "chat message must be 1-79 printable bytes"
    },
    {
      "code": 6033,
      "name": "licensesOpen",
      "msg": "every active license must settle first"
    }
  ],
  "types": [
    {
      "name": "createRoundArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mode",
            "type": {
              "defined": {
                "name": "roundMode"
              }
            }
          },
          {
            "name": "entryFee",
            "type": "u64"
          },
          {
            "name": "minMargin",
            "type": "u64"
          },
          {
            "name": "maxMargin",
            "type": "u64"
          },
          {
            "name": "tickIntervalMs",
            "type": "u32"
          },
          {
            "name": "durationTicks",
            "type": "u64"
          },
          {
            "name": "stepLimit",
            "type": "u32"
          },
          {
            "name": "checkpointEveryTicks",
            "type": "u32"
          },
          {
            "name": "licenseFeeMinBps",
            "type": "u16"
          },
          {
            "name": "licenseFeeMaxBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "entrant",
      "docs": [
        "Public per-entrant record (delegated)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "index",
            "type": "u16"
          },
          {
            "name": "batch",
            "type": "u8"
          },
          {
            "name": "slot",
            "type": "u8"
          },
          {
            "name": "joinedAt",
            "type": "i64"
          },
          {
            "name": "alive",
            "type": "bool"
          },
          {
            "name": "deposited",
            "type": "u64"
          },
          {
            "name": "strategyHash",
            "docs": [
              "sha256 of the final bytecode, written only at settlement."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "strategyVersion",
            "type": "u32"
          },
          {
            "name": "feePriceBps",
            "docs": [
              "Blind-priced license fee (bps of notional per mirrored trade); public."
            ],
            "type": "u16"
          },
          {
            "name": "licenseCount",
            "type": "u16"
          },
          {
            "name": "privatized",
            "type": "bool"
          },
          {
            "name": "settled",
            "type": "bool"
          },
          {
            "name": "hallRecorded",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "hall",
      "docs": [
        "Hall of Fame (L1 only)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "rounds",
            "type": "u32"
          },
          {
            "name": "wins",
            "type": "u32"
          },
          {
            "name": "podiums",
            "type": "u32"
          },
          {
            "name": "totalPnl",
            "type": "i64"
          },
          {
            "name": "elo",
            "type": "i32"
          },
          {
            "name": "bestRank",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "leg",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "size",
            "docs": [
              "Notional, USDC 6dp."
            ],
            "type": "u64"
          },
          {
            "name": "entry",
            "docs": [
              "Entry mark, USDC 6dp."
            ],
            "type": "i64"
          },
          {
            "name": "fundingIndex",
            "type": "i64"
          },
          {
            "name": "side",
            "docs": [
              "+1 long, -1 short, 0 flat."
            ],
            "type": "i8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          }
        ]
      }
    },
    {
      "name": "license",
      "docs": [
        "A licensee's mirror of an author's strategy. Delegated, PRIVATE to",
        "buyer + author, zero-copy. The crank runs the author's bytecode against",
        "these legs; neither the buyer nor anyone else can read the bytecode."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "author",
            "type": "pubkey"
          },
          {
            "name": "margin",
            "docs": [
              "Margin held in the license's custody token account, USDC 6dp."
            ],
            "type": "u64"
          },
          {
            "name": "realizedPnl",
            "docs": [
              "Realized PnL net of license fees."
            ],
            "type": "i64"
          },
          {
            "name": "legs",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "leg"
                  }
                },
                8
              ]
            }
          },
          {
            "name": "mem",
            "docs": [
              "The author's strategy memory, separate per licensee."
            ],
            "type": {
              "array": [
                "i64",
                16
              ]
            }
          },
          {
            "name": "accruedFees",
            "docs": [
              "Fees owed to the author, paid at settlement."
            ],
            "type": "u64"
          },
          {
            "name": "openedTick",
            "type": "u64"
          },
          {
            "name": "lastEquity",
            "type": "i64"
          },
          {
            "name": "peakEquity",
            "type": "i64"
          },
          {
            "name": "ranTick",
            "docs": [
              "Round tick + 1 of the last executed tick (0 = never): one run per tick."
            ],
            "type": "u64"
          },
          {
            "name": "tradeCount",
            "type": "u32"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "active",
            "type": "u8"
          },
          {
            "name": "liquidated",
            "type": "u8"
          },
          {
            "name": "settled",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "lastFault",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                5
              ]
            }
          }
        ]
      }
    },
    {
      "name": "licenseSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "author",
            "type": "pubkey"
          },
          {
            "name": "feesPaid",
            "type": "u64"
          },
          {
            "name": "returned",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "market",
      "docs": [
        "Live per-market state (delegated, public, zero-copy). Indicators are",
        "maintained once per tick here so every strategy's reads are O(1)."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "feed",
            "type": "pubkey"
          },
          {
            "name": "oiCap",
            "type": "u64"
          },
          {
            "name": "oiLong",
            "type": "u64"
          },
          {
            "name": "oiShort",
            "type": "u64"
          },
          {
            "name": "fundingIndex",
            "type": "i64"
          },
          {
            "name": "lastFundingTick",
            "type": "u64"
          },
          {
            "name": "mark",
            "docs": [
              "Mark price, USDC 6dp."
            ],
            "type": "i64"
          },
          {
            "name": "lastPublishTime",
            "type": "i64"
          },
          {
            "name": "lastTick",
            "type": "u64"
          },
          {
            "name": "ring",
            "type": {
              "array": [
                "i64",
                64
              ]
            }
          },
          {
            "name": "ema8",
            "type": "i64"
          },
          {
            "name": "ema21",
            "type": "i64"
          },
          {
            "name": "ema55",
            "type": "i64"
          },
          {
            "name": "vol",
            "docs": [
              "Realized volatility over the ring, scaled fraction (1e6 = 100%)."
            ],
            "type": "i64"
          },
          {
            "name": "fundingRateBps",
            "type": "i32"
          },
          {
            "name": "maintenanceBps",
            "type": "u16"
          },
          {
            "name": "baseSpreadBps",
            "type": "u16"
          },
          {
            "name": "skewSpreadBps",
            "type": "u16"
          },
          {
            "name": "index",
            "type": "u8"
          },
          {
            "name": "decimals",
            "type": "u8"
          },
          {
            "name": "maxLeverage",
            "type": "u8"
          },
          {
            "name": "ringPos",
            "type": "u8"
          },
          {
            "name": "ringLen",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "retSqSum",
            "docs": [
              "Running sum of squared per-tick returns over the ring (scaled 1e12),",
              "maintained incrementally so volatility costs O(1) per tick."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "marketConfig",
      "docs": [
        "Static per-market config stored on the Round (public)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feed",
            "docs": [
              "Oracle price account (Pyth Lazer PriceUpdateV2 pushed by MagicBlock)."
            ],
            "type": "pubkey"
          },
          {
            "name": "decimals",
            "docs": [
              "Price decimals in the oracle account (8 for Pyth Lazer majors)."
            ],
            "type": "u8"
          },
          {
            "name": "maxLeverage",
            "type": "u8"
          },
          {
            "name": "maintenanceBps",
            "type": "u16"
          },
          {
            "name": "baseSpreadBps",
            "type": "u16"
          },
          {
            "name": "skewSpreadBps",
            "docs": [
              "Extra spread per 100% of skew, in bps."
            ],
            "type": "u16"
          },
          {
            "name": "oiCap",
            "docs": [
              "Open-interest cap per side, USDC notional (6dp)."
            ],
            "type": "u64"
          },
          {
            "name": "enabled",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "position",
      "docs": [
        "Trading state. Delegated, PRIVATE to the owner, zero-copy."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "margin",
            "docs": [
              "Margin held in the entrant's custody token account, USDC 6dp."
            ],
            "type": "u64"
          },
          {
            "name": "realizedPnl",
            "type": "i64"
          },
          {
            "name": "legs",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "leg"
                  }
                },
                8
              ]
            }
          },
          {
            "name": "mem",
            "docs": [
              "VM persistent memory."
            ],
            "type": {
              "array": [
                "i64",
                16
              ]
            }
          },
          {
            "name": "sumRet",
            "docs": [
              "Rolling Sharpe accumulators (per-tick equity returns, scaled)."
            ],
            "type": "i64"
          },
          {
            "name": "sumRetSq",
            "type": "i64"
          },
          {
            "name": "lastEquity",
            "type": "i64"
          },
          {
            "name": "peakEquity",
            "type": "i64"
          },
          {
            "name": "ranTick",
            "docs": [
              "Round tick + 1 of the last executed tick (0 = never): one run per tick."
            ],
            "type": "u64"
          },
          {
            "name": "tradeCount",
            "type": "u32"
          },
          {
            "name": "lastSteps",
            "type": "u32"
          },
          {
            "name": "retN",
            "type": "u32"
          },
          {
            "name": "lastFaultPc",
            "type": "u16"
          },
          {
            "name": "lastFault",
            "type": "u8"
          },
          {
            "name": "liquidated",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          }
        ]
      }
    },
    {
      "name": "protocolConfig",
      "docs": [
        "Global protocol config (L1 only)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "protocolFeeBps",
            "type": "u16"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "roundCount",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "round",
      "docs": [
        "A round of the league. Delegated to the TEE for its whole life; public."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u32"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "roundStatus"
              }
            }
          },
          {
            "name": "mode",
            "type": {
              "defined": {
                "name": "roundMode"
              }
            }
          },
          {
            "name": "nMarkets",
            "type": "u8"
          },
          {
            "name": "markets",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "marketConfig"
                  }
                },
                8
              ]
            }
          },
          {
            "name": "mysteryMarket",
            "type": "u8"
          },
          {
            "name": "entryFee",
            "type": "u64"
          },
          {
            "name": "minMargin",
            "type": "u64"
          },
          {
            "name": "maxMargin",
            "type": "u64"
          },
          {
            "name": "tickIntervalMs",
            "type": "u32"
          },
          {
            "name": "durationTicks",
            "type": "u64"
          },
          {
            "name": "tick",
            "docs": [
              "Tick counter advanced by `tick_clock`."
            ],
            "type": "u64"
          },
          {
            "name": "stepLimit",
            "type": "u32"
          },
          {
            "name": "entrantCount",
            "type": "u16"
          },
          {
            "name": "settledCount",
            "type": "u16"
          },
          {
            "name": "openLicenses",
            "docs": [
              "Activated licenses not yet settled; close_round and sweep_vault require 0."
            ],
            "type": "u16"
          },
          {
            "name": "batchCount",
            "type": "u8"
          },
          {
            "name": "prizesPaid",
            "type": "bool"
          },
          {
            "name": "live",
            "docs": [
              "Crank guard: scheduled instructions no-op when false."
            ],
            "type": "bool"
          },
          {
            "name": "vrfSeed",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "vrfReady",
            "type": "bool"
          },
          {
            "name": "pot",
            "docs": [
              "Entry fees collected (USDC 6dp), paid out at settlement."
            ],
            "type": "u64"
          },
          {
            "name": "vaultBalance",
            "docs": [
              "Solvency beacon: what the vault holds vs what entrants are owed."
            ],
            "type": "u64"
          },
          {
            "name": "totalEquity",
            "type": "i64"
          },
          {
            "name": "checkpointEveryTicks",
            "type": "u32"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "startedAt",
            "type": "i64"
          },
          {
            "name": "endedAt",
            "type": "i64"
          },
          {
            "name": "protocolFeeBps",
            "type": "u16"
          },
          {
            "name": "licenseFeeMinBps",
            "type": "u16"
          },
          {
            "name": "licenseFeeMaxBps",
            "type": "u16"
          },
          {
            "name": "validator",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "roundMode",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "lit"
          },
          {
            "name": "dark"
          }
        ]
      }
    },
    {
      "name": "roundStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "created"
          },
          {
            "name": "open"
          },
          {
            "name": "live"
          },
          {
            "name": "settling"
          },
          {
            "name": "settled"
          }
        ]
      }
    },
    {
      "name": "scoreEntry",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "equity",
            "type": "i64"
          },
          {
            "name": "deposited",
            "type": "u64"
          },
          {
            "name": "trades",
            "type": "u32"
          },
          {
            "name": "alive",
            "type": "u8"
          },
          {
            "name": "rank",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "strategyHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "scoreboard",
      "docs": [
        "Leaderboard (zero-copy). Delegated; public in Lit mode, private",
        "(program-only) in Dark mode."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "n",
            "type": "u16"
          },
          {
            "name": "finalized",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "entries",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "scoreEntry"
                  }
                },
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "strategy",
      "docs": [
        "The strategy. Delegated, PRIVATE to the owner, zero-copy. Bytecode never",
        "touches L1 in plaintext: created zeroed, filled on the ER, scrubbed before",
        "undelegation."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "updatedTick",
            "type": "u64"
          },
          {
            "name": "version",
            "type": "u32"
          },
          {
            "name": "stepLimit",
            "type": "u32"
          },
          {
            "name": "len",
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                5
              ]
            }
          },
          {
            "name": "bytecode",
            "type": {
              "array": [
                "u8",
                4096
              ]
            }
          }
        ]
      }
    }
  ]
};
