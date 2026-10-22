# Sprill: DM Read Rate Tracker

A Chrome extension that shows which of your Instagram DMs were read.

Version 0.18.0. Works on instagram.com. Website: https://sprill.app

## What Sprill does

- Instagram puts a DM from a stranger in a Requests folder. Nobody gets told. So silence tells you nothing.
- Sprill reads Instagram's own "Seen" marker on the DMs you sent.
- It splits "read and ignored" from "never opened".
- It scores public accounts against your ideal customer.
- It drafts each message for you. You check it and confirm it.
- It is not a bulk-DM bot. Sending from the panel is off by default.
- If you turn panel sending on, it only sends to people you picked, with a daily cap and a pause between each one.

Sprill is not affiliated with Instagram or Meta.

## Install from source

You need Chrome. There is no build step.

1. Clone this repo.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked**.
5. Pick the `extension/` folder. Not the repo root.
6. Open instagram.com and click the Sprill icon.

It runs fully local. No account, no server, no keys.

## Run the tests

You need Node 18 or newer. No install needed.

```bash
node tests/run.mjs
```

- Expect 0 failed. A fresh clone runs 535 assertions.
- Two suites skip on their own. They need extra packages:

```bash
npm install --no-save jsdom playwright
node tests/run.mjs
```

- The Firestore rules suite (27 checks) runs on its own. It needs the Firebase emulator:

```bash
npx firebase emulators:start --only firestore --project demo-sprill   # terminal 1
node tests/rules/rules.test.mjs                                       # terminal 2
```

## Optional cloud features

Leave these blank and Sprill stays fully local. Fill them in to turn on:

- Google sign-in
- Export to Google Sheets
- Cloud backup

Steps:

1. Copy `extension/src/shared/config.local.example.js` to `extension/src/shared/config.local.js`.
2. Git ignores `config.local.js`. Never commit it.
3. In Google Cloud, make an OAuth client of type **Web application**.
4. Turn on the Google Sheets API and the Google Drive API.
5. Add this redirect URI: `https://<your extension id>.chromiumapp.org/`. Your extension id is on `chrome://extensions`.
6. Put the client id in `GOOGLE_OAUTH_CLIENT_ID`.
7. In Firebase, use the same project. Make a Firestore database. Turn on the Google sign-in provider.
8. Put the web `apiKey` and `projectId` in `FIREBASE`.
9. Deploy the rules:

```bash
npx firebase deploy --only firestore:rules --project <your-project-id>
```

10. Reload the extension on `chrome://extensions`.

Notes:

- These values are public ids, not secrets. Your rules and key limits keep the data safe.
- Never put a real secret in the extension. No private keys, no client secrets.
- `config.js` stops on load if it finds a private key.

## Privacy

By default, all data stays in your browser. Nothing leaves your machine.

Data leaves your machine only if you set up cloud features and turn them on:

- **Google sign-in:** signs you in with your Google account.
- **Sheets export:** writes your list to a sheet Sprill makes in your own Google Drive. Sprill can only see files it made.
- **Cloud backup:** copies your settings, saved accounts and outreach log to your own Firestore project, under your user id.

Sprill never asks for your Instagram password. It never reads your Instagram cookies.

The full policy is in `extension/privacy.html`.

## Repo map

- `extension/`: the extension. This is the folder Chrome loads.
- `tests/`: the test suites. Run them with `node tests/run.mjs`.
- `firestore.rules`: the security rules for cloud backup.
- `firebase.json`: points the emulator and `firebase deploy` at the rules.

## License

MIT. See `LICENSE`.
