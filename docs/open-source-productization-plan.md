# Codex WeChat Handoff Open Source Productization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn this local Codex-WeChat bridge into a WeClaw-comparable open source product that another user can install, onboard, run as a daemon, diagnose, and use for Desktop-to-WeChat carry-over.

**Architecture:** Keep the current Codex-native iLink bridge as the core runtime. Add a product shell around it: installer, first-run onboarding, generic daemon management, doctor, safer config defaults, richer README, AI-agent installation guide, and public-release hygiene. The main product story stays focused on carrying an active Codex Desktop session to WeChat, continuing from the phone, then pulling the same thread back to Desktop.

**Tech Stack:** Bun TypeScript CLI, Codex app-server backend, WeChat iLink HTTP APIs, macOS LaunchAgent for daemon mode, Codex skill installation, HTML artifact rendering through Chrome auto-detect or macOS Quick Look fallback.

---

## Product Positioning

This project should not compete head-on with cc-connect as a broad multi-platform, multi-agent control plane. It should be positioned as:

```text
Codex WeChat Handoff: continue your Codex Desktop coding session from WeChat, then pull it back.
```

The first-run onboarding must lead with carry-over:

```text
1. You are coding in Codex Desktop.
2. Say "carry this to WeChat" or run `codex-wechat carry-current --project current --to last`.
3. Leave your desk and continue the same Codex thread from WeChat.
4. Return to Desktop and run `codex-wechat pull-current --project current`.
5. Then learn other commands: /project, /mode, /model, /status, /help.
```

Everything else, including project switching, model changes, rich PDF/image output, daemon mode, and slash commands, should support that core story rather than distract from it.

---

## Decisions Needed

These decisions should be made before public release. Defaults below are recommended.

1. **Public package/repo name**
   - Recommended: `codex-wechat-handoff`
   - Why: it names the core feature, not just the transport. The product is about handing a live Codex coding session from Desktop to WeChat and back.
   - Strong alternatives:
     - `codex-to-wechat` — clear but sounds one-way and misses pull-back.
     - `codex-wechat-carry` — closer to the feature language, but "carry" is less standard than "handoff".
     - `wechat-codex-remote` — good for remote control, weaker for Desktop-to-phone continuity.
     - `codex-pocket` — memorable, but less explicit and harder to search.
   - Avoid as final public name:
     - `wechat-to-codex` — too generic and directionally confusing because the most distinctive flow starts in Codex Desktop and carries to WeChat.
     - `codex-wechat-bridge` — accurate but undersells the carry-over experience.
   - Product display name: `Codex WeChat Handoff`
   - Package/repo name: `codex-wechat-handoff`
   - CLI name: keep `codex-wechat` because it is shorter and already describes the command surface.
   - Impact: package name, README title, installer URLs, LaunchAgent label, default state dir.

2. **Public install channel for v0.1**
   - Recommended first ship: GitHub repo + `install.sh` + local `codex-wechat` CLI symlink.
   - Later: npm package and Homebrew tap.
   - Impact: how stable `bin/codex-wechat` and dependencies must be before release.

3. **Default state directory**
   - Recommended: `~/.codex-wechat-handoff`
   - Alternative: `~/.codex/channels/wechat`
   - Impact: compatibility with current local setup and clarity for non-Codex internals.

4. **Default allowed sender policy**
   - Recommended: locked-by-default. First successful inbound WeChat sender is explicitly bound by setup/onboarding, or user runs `codex-wechat sender allow`.
   - Avoid: `allowedSenderIds: []` meaning everyone can trigger Codex.
   - Impact: safer public defaults and clearer onboarding.

5. **Default permission mode**
   - Recommended: `read`.
   - `/mode write` allowed with explicit user action.
   - `/mode fullaccess` allowed only after visible warning in README, onboarding, and `/help`.
   - Impact: trust model for remote code work.

6. **Daemon support scope for v0.1**
   - Recommended: macOS LaunchAgent only.
   - Later: Linux systemd and Windows scheduled task/service.
   - Impact: README promise and installer complexity.

---

## Target File Structure

Current large file can remain for v0.1, but public product shell should add focused files:

```text
README.md
INSTALL.md
LICENSE
SECURITY.md
.github/workflows/test.yml
install.sh
package.json
bin/codex-wechat
codex-wechat-ilink.ts
codex-wechat-ilink.test.ts
projects.example.json
docs/open-source-productization-plan.md
docs/troubleshooting.md
docs/security-model.md
skills/codex-wechat/SKILL.md
scripts/install-launch-agent.sh
scripts/uninstall-launch-agent.sh
```

Later, split `codex-wechat-ilink.ts` into modules if it slows development:

```text
src/cli.ts
src/config.ts
src/daemon.ts
src/doctor.ts
src/ilink.ts
src/codex-app-server.ts
src/artifacts.ts
src/state.ts
src/wechat-commands.ts
```

Do not split it only for aesthetics before the public install path works.

---

## Stage 1: Product Identity and Safe Defaults

**Outcome:** The repository no longer reads like a private demo and has safe public defaults.

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `projects.example.json`
- Modify: `codex-wechat-ilink.ts`
- Modify: `codex-wechat-ilink.test.ts`

- [ ] **Step 1: Rename product-facing metadata**

  Update `package.json`:

  ```json
  {
    "name": "codex-wechat-handoff",
    "version": "0.1.0",
    "private": false,
    "type": "module",
    "bin": {
      "codex-wechat": "./bin/codex-wechat"
    },
    "scripts": {
      "qr": "bun codex-wechat-ilink.ts qr",
      "setup": "bun codex-wechat-ilink.ts setup",
      "start": "bun codex-wechat-ilink.ts start",
      "ask": "bun codex-wechat-ilink.ts ask",
      "test": "bun test"
    },
    "dependencies": {
      "qrcode": "^1.5.4"
    },
    "engines": {
      "bun": ">=1.0.0",
      "node": ">=18.0.0"
    }
  }
  ```

- [ ] **Step 2: Update tests for package identity**

  Add or update a test in `codex-wechat-ilink.test.ts`:

  ```ts
  test("package uses public product metadata", () => {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dir, "package.json"), "utf-8"));

    expect(pkg.name).toBe("codex-wechat-handoff");
    expect(pkg.private).toBe(false);
    expect(pkg.bin?.["codex-wechat"]).toBe("./bin/codex-wechat");
  });
  ```

- [ ] **Step 3: Make example config safe**

  Update `projects.example.json` so it does not imply all senders are safe:

  ```json
  {
    "defaultProject": "example",
    "allowedSenderIds": ["replace-with-your-wechat-sender-id-after-binding"],
    "projects": {
      "example": {
        "cwd": "/absolute/path/to/your/project",
        "defaultMode": "read"
      }
    }
  }
  ```

- [ ] **Step 4: Document sender binding policy**

  In `README.md`, add a safety note near project config:

  ```markdown
  By default, expose only explicit sender ids. Do not leave a public install open to every sender. Run `codex-wechat sender allow <sender_id>` after first binding, or use the setup wizard.
  ```

- [ ] **Step 5: Verify**

  Run:

  ```bash
  bun test codex-wechat-ilink.test.ts
  git diff --check
  ```

  Expected:

  ```text
  all tests pass
  no whitespace errors
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add package.json projects.example.json README.md codex-wechat-ilink.test.ts codex-wechat-ilink.ts
  git commit -m "Productize package identity and safe defaults"
  ```

---

## Stage 2: First-Run Init and Doctor

**Outcome:** A new user can run `codex-wechat init` and `codex-wechat doctor` before touching WeChat.

**Files:**
- Modify: `codex-wechat-ilink.ts`
- Modify: `codex-wechat-ilink.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add default state and config helpers**

  Add helpers near current path helpers in `codex-wechat-ilink.ts`:

  ```ts
  const DEFAULT_PRODUCT_STATE_DIR = path.join(os.homedir(), ".codex-wechat-handoff");

  function defaultProjectsFile(stateDir: string): string {
    return path.join(stateDir, "projects.json");
  }

  function resolveDefaultStateDir(args: Args): string {
    return path.resolve(expandHome(optionString(args, "state-dir", DEFAULT_PRODUCT_STATE_DIR)));
  }
  ```

  Then update `runtimeOptions` to use `resolveDefaultStateDir(args)`.

- [ ] **Step 2: Write failing init test**

  Add test:

  ```ts
  test("init creates a safe local projects config", () => {
    withTempDir((dir) => {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "codex-wechat-ilink.ts"),
          "init",
          "--state-dir",
          dir,
          "--project",
          "demo",
          "--cwd",
          dir,
        ],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      const config = JSON.parse(readFileSync(path.join(dir, "projects.json"), "utf-8"));
      expect(config.defaultProject).toBe("demo");
      expect(config.allowedSenderIds).toEqual([]);
      expect(config.projects.demo.defaultMode).toBe("read");
      expect(config.projects.demo.cwd).toBe(dir);
      expect(result.stdout.toString()).toContain("Next: codex-wechat setup");
    });
  });
  ```

- [ ] **Step 3: Implement `commandInit`**

  Add command:

  ```ts
  async function commandInit(options: RuntimeOptions, args: Args): Promise<void> {
    const projectName = optionString(args, "project", "default");
    const cwd = path.resolve(expandHome(optionString(args, "cwd", process.cwd())));
    const projectsPath = typeof args.projects === "string" ? path.resolve(expandHome(args.projects)) : defaultProjectsFile(options.stateDir);
    mkdirSync(path.dirname(projectsPath), { recursive: true });
    const config: ProjectsConfig = {
      defaultProject: projectName,
      allowedSenderIds: [],
      projects: {
        [projectName]: {
          cwd,
          defaultMode: "read",
        },
      },
    };
    writeFileSync(projectsPath, JSON.stringify(config, null, 2), "utf-8");
    console.log(`created: ${projectsPath}`);
    console.log("Next: codex-wechat setup --state-dir <state-dir>");
    console.log("Then: codex-wechat daemon install");
  }
  ```

  Register `init` in `main()` and help output.

- [ ] **Step 4: Write failing doctor test**

  Add test:

  ```ts
  test("doctor reports missing account and project config", () => {
    withTempDir((dir) => {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "codex-wechat-ilink.ts"),
          "doctor",
          "--state-dir",
          dir,
        ],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString();
      expect(output).toContain("account: missing");
      expect(output).toContain("projects: missing");
      expect(output).toContain("codex:");
      expect(output).toContain("bun:");
    });
  });
  ```

- [ ] **Step 5: Implement `commandDoctor`**

  Add doctor checks:

  ```text
  bun executable/version
  codex executable/version
  account.json present and 0600 best effort
  projects config exists and project cwd paths exist
  LaunchAgent status on macOS if installed
  renderer availability: Chrome, qlmanage, sips
  state dir writable
  ```

  Output should be readable text, not JSON by default.

- [ ] **Step 6: Verify**

  Run:

  ```bash
  bun test codex-wechat-ilink.test.ts
  codex-wechat init --state-dir /tmp/codex-wechat-handoff-init-smoke --project smoke --cwd /tmp
  codex-wechat doctor --state-dir /tmp/codex-wechat-handoff-init-smoke
  git diff --check
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add codex-wechat-ilink.ts codex-wechat-ilink.test.ts README.md
  git commit -m "Add first-run init and doctor commands"
  ```

---

## Stage 3: Generic Daemon Management

**Outcome:** A user can install, inspect, tail logs, stop, and uninstall the background listener without editing scripts.

**Files:**
- Modify: `codex-wechat-ilink.ts`
- Modify: `codex-wechat-ilink.test.ts`
- Modify: `scripts/install-launch-agent.sh`
- Modify: `scripts/uninstall-launch-agent.sh`
- Modify: `README.md`

- [ ] **Step 1: Add daemon subcommands**

  Add CLI forms:

  ```text
  codex-wechat daemon install
  codex-wechat daemon status
  codex-wechat daemon logs
  codex-wechat daemon stop
  codex-wechat daemon uninstall
  ```

  These should use a label based on product name:

  ```text
  com.codex-wechat-handoff.daemon
  ```

  Avoid hardcoded user paths.

- [ ] **Step 2: Write daemon plist generation test**

  Extract plist generation into a pure function:

  ```ts
  export function buildLaunchAgentPlist(params: {
    label: string;
    bunBin: string;
    scriptPath: string;
    stateDir: string;
    projectsFile: string;
    codexBin: string;
    workingDirectory: string;
    logDir: string;
  }): string
  ```

  Test:

  ```ts
  test("LaunchAgent plist uses caller-provided paths", () => {
    const plist = buildLaunchAgentPlist({
      label: "com.codex-wechat-handoff.daemon",
      bunBin: "/opt/homebrew/bin/bun",
      scriptPath: "/repo/codex-wechat-ilink.ts",
      stateDir: "/home/alice/.codex-wechat-handoff",
      projectsFile: "/home/alice/.codex-wechat-handoff/projects.json",
      codexBin: "/opt/homebrew/bin/codex",
      workingDirectory: "/repo",
      logDir: "/home/alice/.codex-wechat-handoff/logs",
    });

    expect(plist).toContain("com.codex-wechat-handoff.daemon");
    expect(plist).toContain("/home/alice/.codex-wechat-handoff");
    expect(plist).not.toContain("local-user");
  });
  ```

- [ ] **Step 3: Implement daemon commands**

  `daemon install` should:

  ```text
  resolve bun path
  resolve codex path
  choose stateDir
  choose projects file
  create log dir
  write plist
  run launchctl bootstrap/enable/kickstart
  print next commands
  ```

  `daemon status` should print launchctl state and pid if available.

  `daemon logs` should print:

  ```text
  tail -n 80 <state-dir>/logs/launchd.out.log
  tail -n 80 <state-dir>/logs/launchd.err.log
  ```

  `daemon stop` should bootout but leave plist.

  `daemon uninstall` should bootout and remove plist.

- [ ] **Step 4: Keep scripts as thin wrappers**

  Update `scripts/install-launch-agent.sh`:

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/codex-wechat" daemon install "$@"
  ```

  Update `scripts/uninstall-launch-agent.sh` similarly:

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/codex-wechat" daemon uninstall "$@"
  ```

- [ ] **Step 5: Verify**

  Run:

  ```bash
  bun test codex-wechat-ilink.test.ts
  codex-wechat daemon status --state-dir ./.codex-wechat --projects ./projects.local.json
  git diff --check
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add codex-wechat-ilink.ts codex-wechat-ilink.test.ts scripts/install-launch-agent.sh scripts/uninstall-launch-agent.sh README.md
  git commit -m "Add generic daemon management"
  ```

---

## Stage 4: AI-Agent Installation Guide and One-Prompt Setup

**Outcome:** A user can ask Codex or another coding agent to install the project from one prompt, and the agent has deterministic instructions.

**Files:**
- Create: `INSTALL.md`
- Create: `install.sh`
- Modify: `README.md`
- Modify: `skills/codex-wechat/SKILL.md`

- [ ] **Step 1: Create `INSTALL.md` for agentic installation**

  Add:

  ```markdown
  # Codex WeChat Handoff Installation Guide for AI Agents

  You are helping a user install Codex WeChat Handoff.

  Core product experience:
  1. Carry the current Codex Desktop session to WeChat.
  2. Continue the same thread from the phone.
  3. Pull the mobile continuation back into Codex Desktop.
  4. Then teach project, mode, model, status, and rich artifact commands.

  Never ask the user to paste tokens. Never print account.json.

  Ask the user for:
  - project paths to expose
  - default project name
  - default mode: read, write, or fullaccess
  - whether to install the background daemon
  - whether to install the Codex skill

  Run:
  1. `codex-wechat init`
  2. `codex-wechat setup`
  3. `codex-wechat doctor`
  4. `codex-wechat daemon install`
  5. `codex-wechat carry-current --project current --to last` only from an active Codex thread
  6. Ask the user to send `/status` in WeChat

  First WeChat onboarding message should start with carry-over:
  "To continue this Desktop Codex session on your phone, run `codex-wechat carry-current --project current --to last` from Codex Desktop. When you return, run `codex-wechat pull-current --project current`."
  ```

- [ ] **Step 2: Create `install.sh`**

  Add a conservative installer:

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail

  if ! command -v bun >/dev/null 2>&1; then
    echo "bun is required. Install from https://bun.sh and re-run."
    exit 1
  fi

  if ! command -v codex >/dev/null 2>&1; then
    echo "codex CLI is required. Install/update Codex CLI and re-run."
    exit 1
  fi

  REPO_DIR="${CODEX_WECHAT_HANDOFF_DIR:-$HOME/.codex-wechat-handoff/app}"
  mkdir -p "$(dirname "$REPO_DIR")"

  if [ ! -d "$REPO_DIR/.git" ]; then
    git clone https://github.com/FUY25/codex-wechat-handoff "$REPO_DIR"
  else
    git -C "$REPO_DIR" pull --ff-only
  fi

  mkdir -p "$HOME/.local/bin" "$HOME/.codex/skills"
  ln -sf "$REPO_DIR/bin/codex-wechat" "$HOME/.local/bin/codex-wechat"
  ln -sfn "$REPO_DIR/skills/codex-wechat" "$HOME/.codex/skills/codex-wechat"

  echo "Installed codex-wechat."
  echo "Next: codex-wechat init"
  echo "Then: codex-wechat setup"
  ```

  Replace the GitHub owner before public release if the repository moves.

- [ ] **Step 3: README one-prompt installation section**

  Add near top:

  ```markdown
  ## Install with one prompt

  In Codex Desktop or another local coding agent, say:

  ```text
  Install Codex WeChat Handoff by following:
  https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/main/INSTALL.md

  Start by setting up carry-over from Codex Desktop to WeChat. Then install the daemon, skill, and run doctor. Do not ask me to paste tokens.
  ```
  ```

- [ ] **Step 4: Verify**

  Run:

  ```bash
  shellcheck install.sh scripts/install-launch-agent.sh scripts/uninstall-launch-agent.sh
  bun test codex-wechat-ilink.test.ts
  ```

  If `shellcheck` is unavailable, run:

  ```bash
  bash -n install.sh
  bash -n scripts/install-launch-agent.sh
  bash -n scripts/uninstall-launch-agent.sh
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add INSTALL.md install.sh README.md skills/codex-wechat/SKILL.md
  git commit -m "Add AI-agent guided installation"
  ```

---

## Stage 5: Onboarding UX

**Outcome:** First-time users see carry-over first, then learn other commands.

**Files:**
- Modify: `codex-wechat-ilink.ts`
- Modify: `codex-wechat-ilink.test.ts`
- Modify: `README.md`
- Modify: `skills/codex-wechat/SKILL.md`

- [ ] **Step 1: Add onboarding text builder**

  Add:

  ```ts
  export function buildOnboardingMessage(): string {
    return [
      "连接成功。",
      "",
      "核心用法：把电脑上的 Codex 会话带到微信继续。",
      "1. 在 Codex Desktop 里说：carry this to WeChat",
      "2. 或运行：codex-wechat carry-current --project current --to last",
      "3. 手机微信直接回复，就会继续同一个 Codex thread。",
      "4. 回电脑后运行：codex-wechat pull-current --project current",
      "",
      "其他常用命令：",
      "/projects 查看项目",
      "/project <name> 切项目",
      "/mode read|write|fullaccess 改权限",
      "/model 查看或设置模型",
      "/status 查看当前 thread",
      "/help 查看全部命令",
    ].join("\\n");
  }
  ```

- [ ] **Step 2: Test onboarding order**

  Add:

  ```ts
  test("onboarding starts with carry-over before generic commands", () => {
    const text = buildOnboardingMessage();
    expect(text.indexOf("核心用法")).toBeLessThan(text.indexOf("其他常用命令"));
    expect(text).toContain("codex-wechat carry-current");
    expect(text).toContain("codex-wechat pull-current");
  });
  ```

- [ ] **Step 3: Trigger onboarding after setup**

  After QR login succeeds, print onboarding locally. If a sender is already known and proactive send is available, send it to WeChat; otherwise tell the user to send `/help` after first WeChat message.

- [ ] **Step 4: Add `/onboarding` command**

  Extend parser:

  ```text
  /onboarding
  /intro
  ```

  Both return `buildOnboardingMessage()`.

- [ ] **Step 5: Verify**

  Run:

  ```bash
  bun test codex-wechat-ilink.test.ts
  codex-wechat help
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add codex-wechat-ilink.ts codex-wechat-ilink.test.ts README.md skills/codex-wechat/SKILL.md
  git commit -m "Add carry-over-first onboarding"
  ```

---

## Stage 6: README Rewrite for Public Users

**Outcome:** The README sells and supports the product in the first 60 seconds.

**Files:**
- Rewrite: `README.md`
- Create: `docs/troubleshooting.md`
- Create: `docs/security-model.md`

- [ ] **Step 1: README first screen**

  Replace the top with:

  ```markdown
  # Codex WeChat Handoff

  Continue your Codex Desktop coding session from WeChat, then pull it back.

  Codex WeChat Handoff connects personal WeChat iLink to Codex app-server. It is built for remote coding handoff: start at your desk, continue from your phone, return to the same thread.
  ```

- [ ] **Step 2: Add quick start**

  Add:

  ```markdown
  ## Quick Start

  ```bash
  curl -fsSL https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/main/install.sh | sh
  codex-wechat init
  codex-wechat setup
  codex-wechat daemon install
  codex-wechat doctor
  ```
  ```

- [ ] **Step 3: Put carry-over before slash commands**

  The first usage section must be:

  ```markdown
  ## Carry a Desktop Codex session to WeChat
  ```

  Slash commands should appear after carry-over.

- [ ] **Step 4: Add screenshots/GIF placeholders**

  Add image references:

  ```markdown
  ![Carry-over flow](docs/assets/carry-over-flow.png)
  ![WeChat command surface](docs/assets/wechat-command-surface.png)
  ```

  If assets do not exist yet, create `docs/assets/.gitkeep` and mark screenshots as planned in text rather than broken images.

- [ ] **Step 5: Troubleshooting doc**

  Create `docs/troubleshooting.md` with sections:

  ```text
  QR link says network error
  WeChat message received but no reply
  app-server turn timed out
  duplicate daemon running
  context_token missing
  no Chrome installed for HTML rendering
  image/file send failed
  /mode fullaccess safety
  ```

- [ ] **Step 6: Security model doc**

  Create `docs/security-model.md`:

  ```text
  Official iLink long polling, not reverse engineering
  Token storage and permissions
  Sender allowlist
  Project allowlist
  Permission modes
  Bypass mode warning
  Local daemon logs
  No token sharing
  ```

- [ ] **Step 7: Verify**

  Run:

  ```bash
  bun test codex-wechat-ilink.test.ts
  rg -n "local-user|SamplePlaceholder|UNSET_REPO" README.md INSTALL.md install.sh docs
  ```

  Before release, raw GitHub URLs must point at the final repository and product docs should not contain user-local paths except examples marked as examples.

- [ ] **Step 8: Commit**

  ```bash
  git add README.md docs/troubleshooting.md docs/security-model.md docs/assets/.gitkeep
  git commit -m "Rewrite public README and support docs"
  ```

---

## Stage 7: Public Release Hygiene

**Outcome:** The repo is safe and credible enough for public GitHub traffic.

**Files:**
- Create: `LICENSE`
- Create: `SECURITY.md`
- Create: `.github/workflows/test.yml`
- Modify: `.gitignore`
- Modify: `README.md`

- [ ] **Step 1: Add license**

  Recommended: MIT unless there is a reason to restrict commercial use.

- [ ] **Step 2: Add security policy**

  `SECURITY.md` should state:

  ```text
  Do not file public issues containing tokens, account.json, context_tokens.json, or sender ids.
  Report sensitive security issues by email or private advisory.
  ```

- [ ] **Step 3: Add CI**

  `.github/workflows/test.yml`:

  ```yaml
  name: test

  on:
    push:
    pull_request:

  jobs:
    bun-test:
      runs-on: macos-latest
      steps:
        - uses: actions/checkout@v4
        - uses: oven-sh/setup-bun@v2
        - run: bun install
        - run: bun test codex-wechat-ilink.test.ts
        - run: git diff --check
  ```

- [ ] **Step 4: Expand `.gitignore`**

  Ensure these are ignored:

  ```text
  .codex-wechat/
  projects.local.json
  *.log
  .DS_Store
  ```

- [ ] **Step 5: Verify release-readiness scan**

  Run:

  ```bash
  git ls-files | rg 'account.json|context_tokens|sync_buf|sessions.json|events.jsonl|projects.local.json' && exit 1 || true
  rg -n "local-user|absolute-home-path|bot_token|Bearer|account.json" .
  bun test codex-wechat-ilink.test.ts
  ```

  Expected:

  ```text
  no tracked secrets
  no accidental local-user paths in product docs
  tests pass
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add LICENSE SECURITY.md .github/workflows/test.yml .gitignore README.md
  git commit -m "Add public release hygiene"
  ```

---

## Stage 8: Public Smoke And Sample

**Outcome:** Before release, one full clean install and one real WeChat E2E are recorded.

**Files:**
- Create: `docs/release-smoke.md`
- Optional create: `docs/assets/`

- [ ] **Step 1: Clean install smoke**

  Use a temporary directory and non-default state dir:

  ```bash
  CODEX_WECHAT_HANDOFF_DIR=/tmp/codex-wechat-handoff-install-smoke bash install.sh
  /tmp/codex-wechat-handoff-install-smoke/bin/codex-wechat init --state-dir /tmp/codex-wechat-handoff-state --project smoke --cwd /tmp
  /tmp/codex-wechat-handoff-install-smoke/bin/codex-wechat doctor --state-dir /tmp/codex-wechat-handoff-state
  ```

- [ ] **Step 2: Real login smoke**

  Run:

  ```bash
  codex-wechat setup --state-dir /tmp/codex-wechat-handoff-state
  codex-wechat daemon install --state-dir /tmp/codex-wechat-handoff-state --projects /tmp/codex-wechat-handoff-state/projects.json
  ```

  Scan with iOS WeChat.

- [ ] **Step 3: Real message smoke**

  From WeChat:

  ```text
  /status
  /project smoke
  /mode read
  只回复 ok
  ```

- [ ] **Step 4: Real carry-over smoke**

  From Codex Desktop in a real thread:

  ```bash
  codex-wechat carry-current --project current --to last
  ```

  From WeChat:

  ```text
  继续解释当前改动
  ```

  Back on Desktop:

  ```bash
  codex-wechat pull-current --project current
  ```

- [ ] **Step 5: Real artifact smoke**

  Run:

  ```bash
  codex-wechat render-html --html docs/demo/report.html --pdf /tmp/report.pdf --png /tmp/report.png --renderer auto
  codex-wechat send-file --file /tmp/report.pdf --to last --message "PDF smoke"
  codex-wechat send-image --file /tmp/report.png --to last --message "PNG smoke"
  ```

- [ ] **Step 6: Record evidence**

  Create `docs/release-smoke.md`:

  ```markdown
  # Release Smoke

  Date:
  Commit:
  macOS:
  Codex CLI:
  Bun:
  iLink login:
  Daemon:
  Text reply:
  Carry-over:
  Pull-back:
  PDF send:
  Image send:
  Known caveats:
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add docs/release-smoke.md
  git commit -m "Record public release smoke"
  ```

---

## Definition of Done

The project is ready to ship as a WeClaw-comparable open source product when all are true:

- [ ] A clean Mac can install from one command or one AI-agent prompt.
- [ ] `codex-wechat init` creates a safe config.
- [ ] `codex-wechat setup` logs into WeChat without exposing tokens.
- [ ] `codex-wechat doctor` gives actionable status.
- [ ] `codex-wechat daemon install/status/logs/stop/uninstall` works without hardcoded user paths.
- [ ] First-run onboarding explains carry-over before generic slash commands.
- [ ] Default mode is `read`.
- [ ] Sender access is explicit or clearly bound during setup.
- [ ] README first screen explains Desktop-to-WeChat carry-over.
- [ ] `INSTALL.md` lets Codex or another local agent install the project.
- [ ] PDF/image artifact workflow works through `render-html`, `send-file`, and `send-image`.
- [ ] CI runs tests.
- [ ] No tracked local tokens, sender files, logs, or machine-specific paths.
- [ ] A real release smoke is documented.
