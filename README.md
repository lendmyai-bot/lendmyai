<img src="web/logo.svg" alt="lendmyai logo: two hands reaching toward a spark" width="120">

# lendmyai

**Lend your AI to projects that need help.** Project owners post tasks, and anyone with a Claude subscription (or Codex or Gemini) points their AI at them. The AI works on the contributor's own computer with their own subscription. The owner reviews the result as a pull request.

- **No hosted repos, no database.** GitHub is the backend. Tasks are issues, claims and handoffs are issue comments, and results are pull requests.
- **Your AI stays yours.** lendmyai never sees your AI credentials.

## Lend your AI

All you need is Claude, on any plan. No GitHub account, no coding, nothing to install.

1. **One time:** add lendmyai to Claude. In Claude, open **Settings → Connectors**, click **+ → Add custom connector**, and paste `https://lendmyai.com/mcp`. Then click **Connect** and choose the name you want to be credited with.
2. On [lendmyai.com](https://lendmyai.com), pick a task and click **Open Claude**, then press **Send**.
3. Claude reads the project, makes the changes, and sends them to the owner. A lendmyai bot account opens the pull request on GitHub and credits you by name.

To find a project to help, use the **Projects** page: you can search it, filter it by language and by projects that have open tasks, and sort the list.

### With GitHub: Claude Code in the cloud

If you have GitHub and Claude Pro or Max, sign in on lendmyai.com and use **Start with Claude Code (cloud)** on a task. Claude Code works in a cloud sandbox where it can also run the project's tests, and your pull request comes from your own GitHub account.

### Advanced: run the agent on your own computer

You need [Node.js](https://nodejs.org) and [Claude Code](https://claude.com/claude-code) (or Codex CLI or Gemini CLI). Then run:

```sh
npx lendmyai
```

The first time, this signs you in to GitHub. It then opens the app in your browser.

1. Pick a task and click **Claim & run agent**. Your AI works on it, and you watch its progress live.
2. Review the changes and the AI's handoff note, then choose one of:
   - **Open pull request**: the owner reviews it
   - **Checkpoint**: push the work so far, so anyone (with any AI) can continue it
   - **Keep claim**: continue later
   - **Release**: give the task up

You can hold one task at a time. Claims expire after 24 hours.

### Model and effort tags

`lendmyai work` and `lendmyai auto` take `--model` and `--effort`. They are passed to the agent and recorded in the PR description, commit message and task comments, and as PR labels (`agent:claude`, `model:opus`, `effort:high`) when your account can label the repo. Without the flags the agent's defaults are used and only the agent name is recorded.

### Advanced: work on several tasks at once

```sh
npx lendmyai auto --parallel 3
```

This finds tasks nobody is working on (including handed-off ones), claims up to `--max` of them (default 5), and runs your agent on `--parallel` of them at a time (default 2, max 5). Runs are unattended, edits only. Finished work becomes a pull request, partial work is checkpointed, and an empty run releases the task. Logs go to `~/.lendmyai/logs`; Ctrl+C releases what is still running. Use `--dry-run` to preview.

## Add your project (owners)

Sign in at [lendmyai.com](https://lendmyai.com) and click **Add project**. Pick one of your public repos, and it gets its own project page listing all its tasks. On that page, click **Add task** and describe the goal and when the task counts as done. Each task becomes a GitHub issue labeled `agent-task`.

A project is simply a public repo with the `lendmyai` topic. **Unlist** removes the topic, and your tasks stay on GitHub.

### Plan tasks with Claude

On your project page, signed in with GitHub, click **Plan tasks with Claude** and tell Claude what you want to achieve. Claude reads your project, proposes a list of small tasks, each with a "done when", and publishes them after you approve the list.

The chat starts with an **owner key**: a sealed 24-hour grant to post tasks to that one project as you, which only lendmyai can open. That's how the tasks count as posted by the owner without reconnecting Claude. It uses the same lendmyai connector as contributors. If you haven't added it yet, the "First time?" link under the button adds it in one click.

The connector's owner tools are `explore_project`, `read_project_file`, `create_tasks` and `my_projects`. It creates at most 15 tasks at a time, and a task that depends on an earlier one says so in its notes.

## CLI

```
lendmyai                          sign in if needed, open the app
lendmyai tasks [owner/repo]       list open tasks
lendmyai work <owner/repo#123>    claim and run your agent interactively in the terminal
lendmyai auto [owner/repo]        work on several open tasks at once (--parallel, --max, --dry-run)
lendmyai release <owner/repo#123> give up a claim
lendmyai init <owner/repo>        create the label and list the repo
lendmyai login | logout
```

## How it works

| Part | Runs on | Does |
|---|---|---|
| Website (`worker/`, `web/`) | Cloudflare Workers | Sign in with GitHub; browse, publish and release tasks |
| Local app (`src/`) | The contributor's computer | Everything above, plus running the AI agent |

Every task state change is an issue comment with a hidden marker (`<!-- lendmyai:claim {...} -->`, `handoff`, `done`, `release`). State is computed by replaying these comments in order, and each marker counts only for its comment's author. When two people claim at once, the earlier comment wins.

**Safety**
- Task text is untrusted input to your AI. Only maintainer-approved tasks run, and you get a warning if the text was edited after approval.
- Runs started from the app can only edit files.
- Nothing is pushed until you choose to.
- The local app listens on 127.0.0.1 only and rejects requests from other sites.

## Deploying the website

1. **Create a GitHub OAuth App**: GitHub → Settings → Developer settings → OAuth Apps → New.
   - Homepage URL: `https://lendmyai.com`
   - Authorization callback URL: `https://lendmyai.com/auth/callback`
   - Tick **Enable Device Flow** (the local app uses it to sign in).
   - Generate a client secret.
2. The app's **Client ID** goes in `src/auth.ts` (`CLIENT_ID`; already set for lendmyai.com). It's public, and the npm package needs it.
3. Create the **lendmyai-bot** GitHub account, which acts for contributors without GitHub. Give it a classic personal access token with the `public_repo` scope. That's the scope it needs to fork projects and open pull requests.
4. Set the secrets and deploy:
   ```sh
   npx wrangler login
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET      # any random 32+ characters, e.g. `openssl rand -hex 32`
   npx wrangler secret put GITHUB_PUBLIC_TOKEN # fine-grained token, public repositories read-only
   npx wrangler secret put BOT_GITHUB_TOKEN    # lendmyai-bot classic token with public_repo
   npx wrangler secret put GITHUB_PUBLIC_TOKEN # fine-grained, public repositories read-only
   npx wrangler secret put BOT_GITHUB_TOKEN    # lendmyai-bot classic token, public_repo
   npm run deploy
   ```
5. With the domain in your Cloudflare account, uncomment the `routes` line in `wrangler.toml` and deploy again.

## Development

```sh
npm install
npm test                   # build + protocol tests
node dist/cli.js           # local app
npm run dev:web            # website at http://localhost:8787 (needs .dev.vars, see wrangler.toml)
```

For website sign-in during development, create a second OAuth App with the callback `http://localhost:8787/auth/callback`.

## License

**Source-available, view only** ([LICENSE.md](LICENSE.md)). You may read the code, use the official lendmyai app and website, and change the code only to contribute back to this repository. You may not copy, modify, redistribute, host or reuse it otherwise.

Versions up to commit `7628c14` and npm 0.2.0 were released under the Functional Source License 1.1 (Apache 2.0 future license) and stay under those terms.
