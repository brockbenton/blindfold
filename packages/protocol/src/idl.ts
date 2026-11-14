// HAND-WRITTEN placeholder IDL matching docs/design/00-interfaces.md section 4.
// Replace with target/idl/vault.json once the vault is built (anchor build).
// Discriminators are the first 8 bytes of sha256("global:<snake_name>"),
// sha256("account:<Name>") and sha256("event:<Name>"); idl.test.ts checks them.
import type { Idl } from "@anchor-lang/core";

/** Placeholder program id, used until VAULT_PROGRAM_ID is configured. */
export const PLACEHOLDER_VAULT_PROGRAM_ID = "ANeUjqkEoGcxvmojs6dbryf7CpL4jigAfpysipsnfGR6";

export const VAULT_IDL: Idl = {
  "address": "ANeUjqkEoGcxvmojs6dbryf7CpL4jigAfpysipsnfGR6",
  "metadata": {
    "name": "vault",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Blindfold USDC vault"
  },
  "instructions": [
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
          "writable": true
        },
        {
          "name": "usdc_mint"
        },
        {
          "name": "vault_token",
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
          "writable": true
        },
        {
          "name": "deposit_record",
          "writable": true
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
          "signer": true
        },
        {
          "name": "config",
          "writable": true
        },
        {
          "name": "provider_record",
          "writable": true
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
          "signer": true
        },
        {
          "name": "config"
        },
        {
          "name": "provider_record",
          "writable": true
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
          "signer": true
        },
        {
          "name": "config",
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
      "msg": "Deposit exceeds the maximum"
    },
    {
      "code": 6003,
      "name": "InvalidPubkey",
      "msg": "Cashu pubkey must start with 0x02 or 0x03"
    },
    {
      "code": 6004,
      "name": "WrongMint",
      "msg": "Wrong or non-classic USDC mint"
    },
    {
      "code": 6005,
      "name": "WrongVaultAccount",
      "msg": "Wrong vault token account"
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
      "msg": "Provider appears twice in a batch"
    },
    {
      "code": 6011,
      "name": "ProviderMismatch",
      "msg": "Provider record does not match provider id"
    },
    {
      "code": 6012,
      "name": "ProviderInactive",
      "msg": "Provider is not active"
    },
    {
      "code": 6013,
      "name": "PayoutAccountMismatch",
      "msg": "Payout account does not match the provider record"
    },
    {
      "code": 6014,
      "name": "MathOverflow",
      "msg": "Math overflow"
    }
  ],
  "types": [
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
      "name": "Payout",
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
    }
  ]
};
