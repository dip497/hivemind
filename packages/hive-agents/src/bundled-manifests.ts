// Generated from manifests/*.yaml by scripts/build-bundled-agents.mjs — do not edit.
// An agent that ships in the box is the same thing anyone else can write: a manifest.
import type { BundledAgent } from "./types.js";

export const BUNDLED_AGENTS: readonly BundledAgent[] = [
  {
    "id": "claude",
    "nodeHalf": false,
    "manifest": {
      "manifestVersion": 1,
      "id": "claude",
      "label": "Claude",
      "bin": "claude",
      "aliases": [
        "claude-code"
      ],
      "enabled": true,
      "caps": {
        "promptDelivery": "argv",
        "turnSignal": true,
        "resume": "tile",
        "supervise": "broker",
        "blockedDetection": true
      },
      "icon": {
        "viewBox": "0 0 24 24",
        "attrs": {
          "fill": "currentColor"
        },
        "shapes": [
          {
            "path": {
              "d": "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
            }
          }
        ]
      },
      "spawn": {
        "label": "claude #{n}",
        "labelMode": " · {mode}",
        "titles": [
          "Claude Code"
        ]
      },
      "options": [
        {
          "id": "mode",
          "label": "Permission mode",
          "flag": "--permission-mode",
          "values": {
            "bypassPermissions": [
              "--dangerously-skip-permissions"
            ]
          },
          "unattended": "bypassPermissions"
        },
        {
          "id": "model",
          "label": "Model",
          "flag": "--model"
        },
        {
          "id": "effort",
          "label": "Effort",
          "flag": "--effort"
        }
      ],
      "install": {
        "url": "https://code.claude.com/docs/en/setup",
        "command": "curl -fsSL https://claude.ai/install.sh | bash"
      },
      "detect": {
        "scope": {
          "kind": "tail",
          "n": 20
        },
        "rules": [
          {
            "when": {
              "seq": [
                {
                  "run": "space",
                  "min": 0
                },
                {
                  "lit": "2."
                },
                {
                  "run": "space",
                  "min": 1
                },
                {
                  "lit": "Yes,"
                },
                {
                  "run": "space",
                  "min": 1
                }
              ],
              "at": "start"
            },
            "then": "permission"
          },
          {
            "when": {
              "any": [
                {
                  "seq": [
                    {
                      "run": "space",
                      "min": 0
                    },
                    {
                      "lit": "press enter"
                    }
                  ],
                  "at": "start",
                  "ci": true
                },
                {
                  "contains": "Enter to select"
                },
                {
                  "containsCS": "↑/↓ to navigate"
                },
                {
                  "contains": "Esc to cancel"
                },
                {
                  "contains": "[use arrows"
                }
              ]
            },
            "then": "question"
          },
          {
            "when": {
              "contains": "esc to interrupt"
            },
            "then": "working"
          },
          {
            "when": {
              "seq": [
                {
                  "run": "↑↓·(",
                  "min": 1,
                  "max": 1
                },
                {
                  "run": "space",
                  "min": 0
                },
                {
                  "run": "0123456789.,",
                  "min": 1
                },
                {
                  "run": "space",
                  "min": 0
                },
                {
                  "run": "k",
                  "min": 0,
                  "max": 1
                },
                {
                  "run": "space",
                  "min": 0
                },
                {
                  "lit": "tokens"
                }
              ],
              "ci": true
            },
            "then": "working"
          },
          {
            "when": {
              "seq": [
                {
                  "run": "✻✶✳✢✽⋆✺✹✸✷✵✴✲✱●○◐◓◑◒◍◌*·✚✦✧",
                  "min": 1,
                  "max": 1
                },
                {
                  "run": "space",
                  "min": 1
                },
                {
                  "run": "!space",
                  "min": 1,
                  "max": 1
                },
                {
                  "upTo": "…"
                }
              ]
            },
            "then": "working"
          },
          {
            "when": {
              "all": [
                {
                  "any": [
                    {
                      "seq": [
                        {
                          "lit": "("
                        },
                        {
                          "run": "digit",
                          "min": 1
                        },
                        {
                          "lit": "m"
                        },
                        {
                          "run": "space",
                          "min": 0
                        },
                        {
                          "run": "digit",
                          "min": 1
                        },
                        {
                          "lit": "s"
                        },
                        {
                          "notNext": "word"
                        }
                      ]
                    },
                    {
                      "seq": [
                        {
                          "lit": "("
                        },
                        {
                          "run": "digit",
                          "min": 1
                        },
                        {
                          "lit": "s"
                        },
                        {
                          "run": "space",
                          "min": 0
                        },
                        {
                          "lit": "·"
                        }
                      ]
                    }
                  ]
                },
                {
                  "any": [
                    {
                      "contains": "tokens"
                    },
                    {
                      "contains": "interrupt"
                    },
                    {
                      "contains": "thinking"
                    },
                    {
                      "contains": "effort"
                    }
                  ]
                }
              ]
            },
            "then": "working"
          },
          {
            "when": {
              "seq": [
                {
                  "lit": "waiting for "
                },
                {
                  "run": "digit",
                  "min": 1
                },
                {
                  "lit": " background agent"
                },
                {
                  "run": "s",
                  "min": 0,
                  "max": 1
                },
                {
                  "notNext": "word"
                }
              ],
              "ci": true
            },
            "then": "working",
            "scope": {
              "kind": "screen"
            }
          },
          {
            "when": {
              "any": [
                {
                  "seq": [
                    {
                      "run": "❯>",
                      "min": 1,
                      "max": 1
                    },
                    {
                      "run": "space",
                      "min": 1,
                      "max": 1
                    },
                    {
                      "notNext": "digit"
                    }
                  ],
                  "at": "start"
                },
                {
                  "seq": [
                    {
                      "run": "❯>",
                      "min": 1,
                      "max": 1
                    },
                    {
                      "end": true
                    }
                  ],
                  "at": "start"
                }
              ]
            },
            "then": "idle"
          },
          {
            "when": {
              "all": [
                {
                  "seq": [
                    {
                      "lit": "⏵⏵"
                    },
                    {
                      "run": "space",
                      "min": 0
                    },
                    {
                      "any": [
                        "bypass permissions",
                        "accept edits"
                      ]
                    }
                  ],
                  "ci": true
                },
                {
                  "not": {
                    "any": [
                      {
                        "containsCS": "│"
                      },
                      {
                        "containsCS": "╭"
                      },
                      {
                        "containsCS": "╰"
                      }
                    ]
                  }
                }
              ]
            },
            "then": "idle"
          }
        ],
        "default": "working"
      },
      "session": {
        "bind": {
          "args": [
            "--session-id",
            "{newId}"
          ],
          "unless": [
            "--session-id",
            "--resume",
            "-r",
            "--continue",
            "-c",
            "--from-pr"
          ]
        },
        "resume": {
          "args": [
            "--resume",
            "{id}"
          ],
          "position": "before",
          "from": {
            "tracked": true,
            "bound": "--session-id"
          },
          "fallback": [
            "--continue"
          ]
        }
      },
      "hooks": {
        "arg": "--settings",
        "template": "{\"hooks\":{events}}",
        "events": {
          "SessionStart": {
            "hook": "tracker"
          },
          "PreToolUse": [
            {
              "hook": "plan",
              "matcher": "ExitPlanMode",
              "timeout": 345600
            },
            {
              "hook": "approval",
              "matcher": "supervise",
              "when": "supervised",
              "timeout": 600
            }
          ],
          "Stop": {
            "hook": "stop",
            "timeout": 10
          },
          "SubagentStart": {
            "hook": "subagent",
            "timeout": 10
          },
          "SubagentStop": {
            "hook": "subagent",
            "timeout": 10
          },
          "Notification": {
            "hook": "notification",
            "timeout": 10
          },
          "UserPromptSubmit": {
            "hook": "userPrompt",
            "timeout": 10
          }
        }
      },
      "launch": {
        "hcp": true
      }
    }
  },
  {
    "id": "codex",
    "nodeHalf": false,
    "manifest": {
      "manifestVersion": 1,
      "id": "codex",
      "label": "Codex",
      "bin": "codex",
      "enabled": true,
      "caps": {
        "promptDelivery": "typed",
        "turnSignal": false,
        "resume": "cwd",
        "supervise": "human",
        "blockedDetection": true
      },
      "icon": {
        "viewBox": "0 0 24 24",
        "attrs": {
          "fill": "currentColor",
          "fillRule": "evenodd"
        },
        "shapes": [
          {
            "path": {
              "d": "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
            }
          }
        ]
      },
      "options": [
        {
          "id": "model",
          "label": "Model",
          "flag": "--model"
        },
        {
          "id": "mode",
          "label": "Approval",
          "flag": "--ask-for-approval",
          "default": "on-request"
        },
        {
          "id": "sandbox",
          "label": "Sandbox",
          "flag": "--sandbox",
          "default": "workspace-write"
        }
      ],
      "install": {
        "url": "https://developers.openai.com/codex/cli",
        "command": "npm install -g @openai/codex"
      },
      "detect": {
        "rules": [
          {
            "when": {
              "any": [
                {
                  "contains": "press enter to confirm or esc to cancel"
                },
                {
                  "contains": "enter to submit answer"
                },
                {
                  "contains": "allow command?"
                },
                {
                  "contains": "[y/n]"
                },
                {
                  "contains": "yes (y)"
                },
                {
                  "helper": "hasConfirmationPrompt"
                }
              ]
            },
            "then": "blocked"
          },
          {
            "when": {
              "helper": "hasInterruptPattern"
            },
            "then": "working"
          },
          {
            "when": {
              "line": [
                {
                  "startsWith": "•"
                },
                {
                  "containsCS": "Working ("
                }
              ]
            },
            "then": "working"
          }
        ],
        "default": "idle"
      },
      "note": "scrape-only status and no turn signal — drive it by hand on the canvas; `hive ctl read` / `hive ctl workflow` cannot gather from it.",
      "session": {
        "resume": {
          "args": [
            "resume",
            "{id}"
          ],
          "find": {
            "strategy": "jsonl-header",
            "root": "{home}/.codex/sessions",
            "cwdPath": "payload.cwd",
            "idPath": "payload.id",
            "require": {
              "type": "session_meta"
            }
          }
        }
      }
    }
  },
  {
    "id": "cursor",
    "nodeHalf": false,
    "manifest": {
      "manifestVersion": 1,
      "id": "cursor",
      "label": "Cursor",
      "bin": "cursor-agent",
      "aliases": [
        "cursor"
      ],
      "enabled": true,
      "caps": {
        "promptDelivery": "typed",
        "turnSignal": false,
        "resume": "cwd",
        "supervise": "human",
        "blockedDetection": true
      },
      "icon": {
        "viewBox": "0 0 24 24",
        "attrs": {
          "fill": "currentColor"
        },
        "shapes": [
          {
            "path": {
              "d": "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"
            }
          }
        ]
      },
      "options": [
        {
          "id": "mode",
          "label": "Mode",
          "flag": "--mode",
          "values": {
            "auto-review": [
              "--auto-review"
            ],
            "force": [
              "--force"
            ]
          },
          "unattended": "force"
        },
        {
          "id": "model",
          "label": "Model",
          "flag": "--model",
          "list": {
            "args": [
              "models"
            ]
          }
        }
      ],
      "install": {
        "url": "https://cursor.com/docs/cli/installation",
        "command": "curl https://cursor.com/install -fsS | bash"
      },
      "detect": {
        "rules": [
          {
            "when": {
              "any": [
                {
                  "contains": "waiting for approval"
                },
                {
                  "contains": "run this command?"
                },
                {
                  "contains": "(y) (enter)"
                },
                {
                  "contains": "keep (n)"
                },
                {
                  "contains": "skip (esc or n)"
                }
              ]
            },
            "then": "blocked"
          },
          {
            "when": {
              "line": [
                {
                  "contains": "(y)"
                },
                {
                  "anyOf": [
                    {
                      "contains": "allow"
                    },
                    {
                      "contains": "run (once)"
                    },
                    {
                      "contains": "→ run"
                    },
                    {
                      "startsWith": "run "
                    }
                  ]
                }
              ]
            },
            "then": "blocked"
          },
          {
            "when": {
              "contains": "ctrl+c to stop"
            },
            "then": "working"
          },
          {
            "when": {
              "line": [
                {
                  "gerundAfterPrefix": [
                    "⬡",
                    "⬢",
                    "braille"
                  ]
                }
              ]
            },
            "then": "working"
          }
        ],
        "default": "idle"
      },
      "note": "no turn reporting, so other agents cannot collect its replies.",
      "session": {
        "resume": {
          "args": [
            "--resume",
            "{id}"
          ],
          "find": {
            "strategy": "dir-meta",
            "root": "{home}/.cursor/chats",
            "dirKey": "md5-cwd",
            "meta": "meta.json",
            "newestBy": [
              "updatedAtMs",
              "createdAtMs"
            ],
            "skipWhen": {
              "hasConversation": false
            }
          }
        }
      }
    }
  },
  {
    "id": "droid",
    "nodeHalf": false,
    "manifest": {
      "manifestVersion": 1,
      "id": "droid",
      "label": "Droid",
      "bin": "droid",
      "enabled": true,
      "caps": {
        "promptDelivery": "typed",
        "turnSignal": true,
        "resume": "cwd",
        "supervise": "human",
        "blockedDetection": true
      },
      "icon": {
        "viewBox": "0 0 24 24",
        "attrs": {
          "fill": "none",
          "stroke": "currentColor",
          "strokeWidth": "1.2"
        },
        "shapes": [
          {
            "ellipse": {
              "cx": "12",
              "cy": "12",
              "rx": "10",
              "ry": "2.6"
            }
          },
          {
            "ellipse": {
              "cx": "12",
              "cy": "12",
              "rx": "10",
              "ry": "2.6",
              "transform": "rotate(45 12 12)"
            }
          },
          {
            "ellipse": {
              "cx": "12",
              "cy": "12",
              "rx": "10",
              "ry": "2.6",
              "transform": "rotate(90 12 12)"
            }
          },
          {
            "ellipse": {
              "cx": "12",
              "cy": "12",
              "rx": "10",
              "ry": "2.6",
              "transform": "rotate(135 12 12)"
            }
          }
        ]
      },
      "options": [
        {
          "id": "mode",
          "label": "Autonomy",
          "flag": "--auto",
          "unattended": "high"
        }
      ],
      "install": {
        "url": "https://docs.factory.ai/cli/getting-started/quickstart",
        "command": "curl -fsSL https://app.factory.ai/cli | sh"
      },
      "detect": {
        "rules": [
          {
            "when": {
              "all": [
                {
                  "containsCS": "EXECUTE"
                },
                {
                  "any": [
                    {
                      "contains": "enter to select"
                    },
                    {
                      "contains": "↑↓ to navigate"
                    },
                    {
                      "contains": "esc to cancel"
                    },
                    {
                      "contains": "> yes, allow"
                    },
                    {
                      "contains": "> no, cancel"
                    }
                  ]
                }
              ]
            },
            "then": "blocked"
          },
          {
            "when": {
              "all": [
                {
                  "any": [
                    {
                      "contains": "enter to select"
                    },
                    {
                      "contains": "↑↓ to navigate"
                    },
                    {
                      "contains": "esc to cancel"
                    }
                  ]
                },
                {
                  "any": [
                    {
                      "contains": "> yes, allow"
                    },
                    {
                      "contains": "> no, cancel"
                    }
                  ]
                }
              ]
            },
            "then": "blocked"
          },
          {
            "when": {
              "contains": "esc to stop"
            },
            "then": "working"
          }
        ],
        "default": "idle"
      },
      "session": {
        "resume": {
          "args": [
            "--resume",
            "{id}"
          ],
          "find": {
            "strategy": "jsonl-header",
            "root": "{home}/.factory/sessions",
            "cwdPath": "cwd",
            "idPath": "id",
            "require": {
              "type": "session_start"
            }
          }
        }
      },
      "home": {
        "root": "droid-home",
        "dir": ".factory",
        "mirror": "{home}/.factory",
        "env": "FACTORY_HOME_OVERRIDE",
        "own": [
          {
            "name": "settings.local.json",
            "merge": true,
            "set": {
              "disableAutoUpdate": true
            }
          }
        ]
      },
      "hooks": {
        "file": "hooks.json",
        "template": "{events}",
        "events": {
          "UserPromptSubmit": {
            "hook": "userPrompt",
            "timeout": 10
          },
          "Stop": {
            "hook": "stop",
            "timeout": 10
          },
          "Notification": {
            "hook": "notification",
            "timeout": 10
          }
        }
      },
      "launch": {
        "hcp": true
      }
    }
  },
  {
    "id": "pi",
    "nodeHalf": false,
    "manifest": {
      "manifestVersion": 1,
      "id": "pi",
      "label": "Pi",
      "bin": "pi",
      "enabled": true,
      "caps": {
        "promptDelivery": "argv",
        "turnSignal": true,
        "resume": "cwd",
        "supervise": "none",
        "blockedDetection": false
      },
      "icon": {
        "viewBox": "0 0 800 800",
        "attrs": {
          "fill": "currentColor",
          "fillRule": "evenodd"
        },
        "shapes": [
          {
            "path": {
              "d": "M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
            }
          },
          {
            "path": {
              "d": "M517.36 400 H634.72 V634.72 H517.36 Z"
            }
          }
        ]
      },
      "options": [
        {
          "id": "model",
          "label": "Model",
          "flag": "--model",
          "list": {
            "args": [
              "--list-models"
            ],
            "skip": 1,
            "format": "{1}/{2}"
          }
        }
      ],
      "spawn": {
        "titles": [
          "π - {task} - {any}",
          "π - {any}"
        ]
      },
      "install": {
        "url": "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md",
        "command": "npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
      },
      "detect": {
        "rules": [
          {
            "when": {
              "containsCS": "Working..."
            },
            "then": "working"
          }
        ],
        "default": "idle"
      },
      "note": "pi has no permission system: it always runs autonomously and cannot be supervised.",
      "session": {
        "resume": {
          "args": [
            "--session",
            "{id}"
          ],
          "find": {
            "strategy": "jsonl-header",
            "root": "{home}/.pi/agent/sessions",
            "cwdPath": "cwd",
            "idPath": "id",
            "require": {
              "type": "session"
            }
          }
        }
      },
      "assets": [
        {
          "name": "hive-pi-ext.mjs",
          "file": "hive-pi-ext.mjs"
        }
      ],
      "launch": {
        "hcp": true,
        "args": [
          "-e",
          "{asset:hive-pi-ext.mjs}"
        ]
      }
    }
  },
  {
    "id": "kiro",
    "nodeHalf": false,
    "manifest": {
      "manifestVersion": 1,
      "id": "kiro",
      "label": "Kiro",
      "bin": "kiro-cli",
      "aliases": [
        "kiro"
      ],
      "enabled": true,
      "caps": {
        "promptDelivery": "typed",
        "turnSignal": true,
        "resume": "tile",
        "supervise": "broker",
        "blockedDetection": true
      },
      "icon": {
        "viewBox": "0 0 24 24",
        "attrs": {
          "fill": "currentColor",
          "fillRule": "evenodd"
        },
        "shapes": [
          {
            "path": {
              "d": "M4.594 6.677C6.67-2.226 18.746-2.211 21.16 6.632c.353 1.297 1.725 7.582-1.673 13.747-1.545 2.797-5.841 5.49-6.99 1.883C8.6 25.477 3.315 24.1 5.789 18.609l-.318.143c-3.57 1.305-3.863-1.208-3.173-2.513.45-.84.727-1.335.937-1.897.353-.975.458-1.568.593-2.498.27-1.837.277-3.607.765-5.167zm8.37.01a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.214-.705 1.214-1.89 0-.622-.127-1.125-.367-1.455a1.014 1.014 0 00-.855-.435zm4.08 0a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.215-.705 1.215-1.89 0-.622-.128-1.125-.368-1.455a1.014 1.014 0 00-.855-.435z"
            }
          }
        ]
      },
      "install": {
        "url": "https://kiro.dev/docs/cli/",
        "command": "curl -fsSL https://cli.kiro.dev/install | bash"
      },
      "detect": {
        "rules": [
          {
            "when": {
              "any": [
                {
                  "all": [
                    {
                      "any": [
                        {
                          "contains": "enter to select"
                        },
                        {
                          "contains": "enter to confirm"
                        },
                        {
                          "contains": "↑/↓"
                        },
                        {
                          "contains": "y/n"
                        }
                      ]
                    },
                    {
                      "all": [
                        {
                          "contains": "allow"
                        },
                        {
                          "any": [
                            {
                              "contains": "deny"
                            },
                            {
                              "contains": "reject"
                            },
                            {
                              "contains": "trust"
                            }
                          ]
                        }
                      ]
                    }
                  ]
                },
                {
                  "helper": "hasConfirmationPrompt"
                }
              ]
            },
            "then": "blocked"
          },
          {
            "when": {
              "any": [
                {
                  "contains": "kiro is working"
                },
                {
                  "all": [
                    {
                      "contains": "esc to cancel"
                    },
                    {
                      "line": [
                        {
                          "letterAfterPrefix": [
                            "◔",
                            "◑",
                            "◕",
                            "●"
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            },
            "then": "working"
          }
        ],
        "default": "idle"
      },
      "home": {
        "root": "kiro-home",
        "dir": ".kiro",
        "mirror": "{home}/.kiro",
        "env": "KIRO_HOME"
      },
      "assets": [
        {
          "name": "hcp-kiro-approval-hook.cjs",
          "file": "hcp-kiro-approval-hook.cjs"
        }
      ],
      "hooks": {
        "file": "agents/hivemind.json",
        "template": "{\"name\":\"hivemind\",\"description\":\"hivemind control-plane wiring (auto-generated — do not edit by hand)\",\"hooks\":{events}}",
        "entry": {
          "command": "{command}",
          "matcher": "{matcher}"
        },
        "group": false,
        "events": {
          "agentSpawn": {
            "hook": "tracker"
          },
          "userPromptSubmit": [
            {
              "hook": "tracker"
            },
            {
              "hook": "userPrompt"
            }
          ],
          "stop": {
            "hook": "stop"
          },
          "preToolUse": {
            "hook": "kiroApproval",
            "matcher": "*"
          }
        }
      },
      "session": {
        "resume": {
          "args": [
            "--resume-id",
            "{id}"
          ],
          "fallback": [
            "--resume"
          ],
          "position": "beforeLaunch",
          "from": {
            "tracked": true
          }
        }
      },
      "launch": {
        "hcp": true,
        "requiresHome": true,
        "subcommand": "chat",
        "args": [
          "--agent",
          "hivemind"
        ]
      }
    }
  },
  {
    "id": "openclaw",
    "nodeHalf": false,
    "manifest": {
      "manifestVersion": 1,
      "id": "openclaw",
      "label": "OpenClaw",
      "bin": "openclaw",
      "enabled": false,
      "caps": {
        "promptDelivery": "typed",
        "turnSignal": false,
        "resume": "none",
        "supervise": "human",
        "blockedDetection": false
      },
      "icon": {
        "viewBox": "0 0 24 24",
        "attrs": {
          "fill": "currentColor",
          "fill-rule": "evenodd"
        },
        "shapes": [
          {
            "path": {
              "d": "M9.046 7.104a.527.527 0 1 1 0 1.055a.527.527 0 0 1 0-1.055m6.33 0a.528.528 0 1 1 0 1.056a.528.528 0 0 1 0-1.056"
            }
          },
          {
            "path": {
              "d": "M16.877 1.912c.58-.27 1.14-.323 1.616-.037a.317.317 0 0 1-.326.542c-.227-.136-.547-.153-1.022.068c-.352.165-.765.45-1.234.866c2.683 1.17 4.4 3.5 5.148 5.921a6 6 0 0 0-.704.184c-.578.016-1.174.204-1.502.735c-.338.55-.268 1.276.072 2.069l.005.012l.007.014c.523 1.045 1.318 1.91 2.2 2.284c-.912 3.274-3.44 6.144-5.972 6.988v2.109h-2.11v-2.11c-1.043.417-2.086.01-2.11 0v2.11h-2.11v-2.11c-2.531-.843-5.061-3.713-5.973-6.987c.882-.373 1.678-1.238 2.2-2.284l.007-.014l.006-.012c.34-.793.41-1.518.071-2.069c-.327-.531-.923-.719-1.503-.735a6 6 0 0 0-.704-.183c.749-2.421 2.466-4.751 5.149-5.922c-.47-.416-.88-.701-1.234-.866c-.474-.221-.794-.204-1.021-.068a.32.32 0 0 1-.435-.109a.317.317 0 0 1 .109-.433c.476-.286 1.036-.233 1.615.037c.49.229 1.031.628 1.621 1.182A9.9 9.9 0 0 1 12 2.568a9.9 9.9 0 0 1 3.256.526c.59-.554 1.13-.953 1.62-1.182zM8.835 6.577a1.266 1.266 0 1 0 0 2.532a1.266 1.266 0 0 0 0-2.532m6.33 0a1.267 1.267 0 1 0 0 2.533a1.267 1.267 0 0 0 0-2.533",
              "clip-rule": "evenodd"
            }
          },
          {
            "path": {
              "d": "M.395 13.118c-.966-1.932-.163-3.863 2.41-3.365v-.001l.05.01q.125.027.26.06l.1.027q.125.034.255.076l.09.027c.528 0 .95.158 1.16.501c.212.343.212.87-.105 1.61q-.128.255-.276.489l-.01.017a5 5 0 0 1-.62.791l-.019.02c-1.092 1.117-2.496 1.336-3.295-.262m20.798-3.365c2.574-.5 3.378 1.433 2.411 3.365c-.58 1.159-1.476 1.361-2.342.96l-.011-.005l-.114-.056l-.019-.01l-.115-.067l-.023-.014l-.106-.068l-.05-.035c-.55-.388-1.062-1.007-1.44-1.76c-.276-.647-.311-1.132-.174-1.472c.176-.439.636-.639 1.23-.639q.049-.016.099-.03q.12-.039.238-.072l.117-.03a6 6 0 0 1 .3-.067z"
            }
          }
        ]
      },
      "note": "not spawnable and not status-scraped yet; no detector strings captured."
    }
  }
] as const;
