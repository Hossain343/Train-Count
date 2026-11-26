# Contributing to Train Count

Thanks for taking the time to contribute! 🎉

## Ground rules

- **Zero runtime dependencies.** The backend uses only Node's standard library, and the front end
  is plain HTML/CSS/JS. Please keep it that way — dev-only tools (like Playwright) are fine.
- **Keep the UI Persian/RTL.** It is the product's language; new strings should be Persian,
  code and comments in English.
- **Every behaviour change needs a test.** The suite is the contract.

## Getting started

```bash
git clone https://github.com/USERNAME/train-count.git
cd train-count

# accounts for local development (nothing is hard-coded in the repo)
export SEED_ACCOUNTS='[{"username":"dev","name":"Dev","password":"dev-password"}]'
npm start          # http://localhost:3000

npm test           # API + logic suite (fast, no deps)
npm i -D playwright && npx playwright install chromium   # once
npm run test:ui    # real-browser suite
```

## Pull requests

1. Fork the repo and create a branch: `git checkout -b feat/my-feature`.
2. Write the code **and** the tests.
3. Make sure `npm test` (and `npm run test:ui` when you touched the UI) is green.
4. Use clear commit messages, e.g. `feat(web): add CSV export`, `fix(api): reject future dates`.
5. Open the PR and describe *what* and *why*.

## Reporting bugs

Please include:

- what you did, what you expected, what happened;
- Node version (`node -v`) and browser;
- any console/server output — **but never paste real student names or passwords**.

## Security

If you find a security issue, please do not open a public issue first.
Send a private report to the repository owner, and give a reasonable amount of time for a fix
before disclosure.
