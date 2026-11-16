// GENERATED from target/idl/vault.json (anchor build, Anchor 1.2.2). Do not edit by hand.
// Regenerate: copy target/idl/vault.json here after `anchor build`.
import type { Idl } from "@anchor-lang/core";

/** Default vault program id (devnet deployment). Overridable via VAULT_PROGRAM_ID. */
export const VAULT_PROGRAM_ID = "EsB6NfKVPipU5kEVm2jq14cjopbE7w9hPEFZWVu8jtMo";
/** Kept for compatibility with earlier imports; now the real program id. */
export const PLACEHOLDER_VAULT_PROGRAM_ID = VAULT_PROGRAM_ID;

export const VAULT_IDL: Idl = {
  "address": "EsB6NfKVPipU5kEVm2jq14cjopbE7w9hPEFZWVu8jtMo",
  "metadata": {
    "name": "vault",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Blindfold USDC vault"
  },
  "instructions": [
    {
      "name": "deactivate_provider",
      "discriminator": [
        221,
        82,
        162,
        241,
        109,
        251,
        145,
        153
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
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
          "name": "provider_record",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  118,
                  105,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "provider_id"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "provider_id",
          "type": "u32"
        }
      ]
    },
    {
      "name": "deposit",
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "depositor",
          "writable": true,
          "signer": true
        },
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
          "name": "deposit_record",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "config.deposit_count",
                "account": "Config"
              }
            ]
          }
        },
        {
          "name": "depositor_token",
          "writable": true
        },
        {
          "name": "vault_token",
          "writable": true
        },
        {
          "name": "usdc_mint"
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "deposit_ref",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
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
          "name": "usdc_mint",
          "docs": [
            "with `WrongMint` before any account is created). Its layout is validated by the",
            "associated token account initialization below."
          ]
        },
        {
          "name": "vault_token",
          "docs": [
            "owner check, so a Token-2022 mint fails with `WrongMint` rather than inside the ATA program."
          ],
          "writable": true
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associated_token_program",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "mint_authority",
          "type": "pubkey"
        },
        {
          "name": "max_deposit",
          "type": "u64"
        }
      ]
    },
    {
      "name": "register_provider",
      "discriminator": [
        254,
        209,
        54,
        184,
        46,
        197,
        109,
        78
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
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
          "name": "provider_record",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  118,
                  105,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "config.provider_count",
                "account": "Config"
              }
            ]
          }
        },
        {
          "name": "payout_token_account"
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "cashu_pubkey",
          "type": {
            "array": [
              "u8",
              33
            ]
          }
        },
        {
          "name": "payout_token",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "settle_batch",
      "discriminator": [
        22,
        2,
        21,
        223,
        225,
        122,
        163,
        214
      ],
      "accounts": [
        {
          "name": "mint_authority",
          "signer": true,
          "relations": [
            "config"
          ]
        },
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
          "name": "vault_token",
          "writable": true
        },
        {
          "name": "usdc_mint"
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "batch_id",
          "type": "u64"
        },
        {
          "name": "payouts",
          "type": {
            "vec": {
              "defined": {
                "name": "Payout"
              }
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "Config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "DepositRecord",
      "discriminator": [
        83,
        232,
        10,
        31,
        251,
        49,
        189,
        167
      ]
    },
    {
      "name": "ProviderRecord",
      "discriminator": [
        137,
        14,
        127,
        97,
        57,
        81,
        55,
        210
      ]
    }
  ],
  "events": [
    {
      "name": "BatchSettled",
      "discriminator": [
        238,
        14,
        187,
        192,
        127,
        95,
        104,
        9
      ]
    },
    {
      "name": "DepositMade",
      "discriminator": [
        210,
        201,
        130,
        183,
        244,
        203,
        155,
        199
      ]
    },
    {
      "name": "ProviderDeactivated",
      "discriminator": [
        136,
        31,
        98,
        109,
        184,
        255,
        123,
        222
      ]
    },
    {
      "name": "ProviderRegistered",
      "discriminator": [
        38,
        209,
        137,
        78,
        185,
        19,
        147,
        14
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "InvalidAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6001,
      "name": "AmountNotWholeCents",
      "msg": "Amount must be a whole number of cents"
    },
    {
      "code": 6002,
      "name": "DepositTooLarge",
      "msg": "Deposit exceeds the maximum deposit"
    },
    {
      "code": 6003,
      "name": "InvalidPubkey",
      "msg": "Cashu public key must be a compressed secp256k1 point (prefix 0x02 or 0x03)"
    },
    {
      "code": 6004,
      "name": "WrongMint",
      "msg": "Token mint is not the vault USDC mint"
    },
    {
      "code": 6005,
      "name": "WrongVaultAccount",
      "msg": "Vault token account is not the configured vault account"
    },
    {
      "code": 6006,
      "name": "Unauthorized",
      "msg": "Signer is not authorized"
    },
    {
      "code": 6007,
      "name": "BadBatchId",
      "msg": "Batch id must be last_batch_id + 1"
    },
    {
      "code": 6008,
      "name": "TooManyPayouts",
      "msg": "Too many payouts in one batch"
    },
    {
      "code": 6009,
      "name": "EmptyBatch",
      "msg": "Batch has no payouts"
    },
    {
      "code": 6010,
      "name": "DuplicateProvider",
      "msg": "Provider appears twice in one batch"
    },
    {
      "code": 6011,
      "name": "ProviderMismatch",
      "msg": "Provider record account is missing, invalid or does not match the payout"
    },
    {
      "code": 6012,
      "name": "ProviderInactive",
      "msg": "Provider is inactive"
    },
    {
      "code": 6013,
      "name": "PayoutAccountMismatch",
      "msg": "Payout token account differs from the registered one"
    },
    {
      "code": 6014,
      "name": "MathOverflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "BatchSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "batch_id",
            "type": "u64"
          },
          {
            "name": "total",
            "type": "u64"
          },
          {
            "name": "count",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "Config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "mint_authority",
            "type": "pubkey"
          },
          {
            "name": "usdc_mint",
            "type": "pubkey"
          },
          {
            "name": "vault_token",
            "type": "pubkey"
          },
          {
            "name": "max_deposit",
            "docs": [
              "Base units."
            ],
            "type": "u64"
          },
          {
            "name": "deposit_count",
            "type": "u64"
          },
          {
            "name": "provider_count",
            "type": "u32"
          },
          {
            "name": "last_batch_id",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "DepositMade",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "index",
            "type": "u64"
          },
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "deposit_ref",
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
      "name": "DepositRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "index",
            "type": "u64"
          },
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "docs": [
              "Base units."
            ],
            "type": "u64"
          },
          {
            "name": "deposit_ref",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "Payout",
      "docs": [
        "`amount` is in base units."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "provider_id",
            "type": "u32"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "ProviderDeactivated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "provider_id",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "ProviderRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "provider_id",
            "type": "u32"
          },
          {
            "name": "cashu_pubkey",
            "type": {
              "array": [
                "u8",
                33
              ]
            }
          },
          {
            "name": "payout_token",
            "type": "pubkey"
          },
          {
            "name": "active",
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
      "name": "ProviderRegistered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "provider_id",
            "type": "u32"
          },
          {
            "name": "cashu_pubkey",
            "type": {
              "array": [
                "u8",
                33
              ]
            }
          },
          {
            "name": "payout_token",
            "type": "pubkey"
          }
        ]
      }
    }
  ]
};
