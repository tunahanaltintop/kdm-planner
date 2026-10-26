# KDM Planner

Plan your week in your notes and enter it into the **KDM** work tracker. KDM Planner adds a weekly planning block you can
put in any note, a quick "send to KDM" dialog for every note, and a weekly calendar view that mirrors the planning page
of KDM, with the same actions.

> KDM Planner is a community plugin. It is not affiliated with or endorsed by the operator of KDM. It talks to KDM the
> same way KDM's own web page does, using your own account.

The plugin's interface is in **Turkish**, matching KDM.

## Features

- **Weekly plan block** (`kdm-week`): a week of notes inside an ordinary note, one area per day, each day split into
  *morning* and *afternoon* around the lunch break. Add, edit and delete notes right in the block.
- **Send to KDM**: a button next to every note opens a quick dialog that is already filled in: the task is matched from
  your task list, the description is the note, and the time is the first free slot (or the time you wrote). Notes about
  leave are entered as a leave day.
- **KDM calendar view**: the weekly calendar of KDM's planning page (08:00-18:00, 30 minute cells) inside Obsidian. Click a
  cell to add, click an entry to edit, drag to move, drag the bottom edge to resize, right-click for the menu.
- **All actions of KDM's planning page**: add, edit, move, resize, mark as completed, delete, leave days (whole days or
  hours). Past weeks are locked exactly as in KDM and open in a read-only view.
- **Your own rules**: tasks of 4 hours or more are refused, a break between tasks is expected (a warning), and the lunch
  break is never used for a suggested slot. The "other task" type is never created.
- **Stays in step with KDM**: entries already in KDM are shown above your notes, notes that were sent follow KDM when
  you press *Yenile* (refresh), and a note whose entry was deleted in KDM becomes an unsent note again. Notes you have
  not sent are never touched by a refresh.
- **Safe by design**: buttons that call KDM are disabled while the request runs, the view refreshes when it succeeds and
  the button comes back when it fails.
- The access token is kept in Obsidian's **secret storage**, is sent only over **HTTPS** and only to the KDM URL it was issued for. Your password is never stored.

## Requirements

- Obsidian **1.13.0** or later (desktop and mobile).
- A **KDM account** and the address of your KDM site (**KDM URL**, entered in the settings).
- Internet access to that site.

## Setup

1. Install and enable the plugin.
2. Open **Settings → KDM Planner**, enter your KDM **email** (and the address if yours differs).
3. Press **Giriş yap** (log in) and type your password. The plugin keeps the access token, renews it automatically, and
   downloads your task list once per login.

## Using it

### Weekly plan block

Run **Haftalık plan bloğu ekle** from the command palette, or press the calendar button in the header of any note. A
dialog asks for the week (last, this, next, or any date). The block is plain text, so it also works in source mode:

````
```kdm-week
hafta: 2026-10-26
## Pzt 26.10
### Öğleden önce
- 09:00-10:30 Customer meeting
- Prepare report
### Öğleden sonra
- Contract draft
## Sal 27.10
### Öğleden önce
### Öğleden sonra
```
````

Switch the note to reading mode to see the planner. A note may start with a time range (`09:00-10:30`). A sent note ends
with a marker such as `{kdm:123456}` that links it to its KDM entry.

Per note: **KDM'ye aktar** (send), ✎ (edit: the KDM entry for sent notes, the text for others), ✓ (complete) and × (delete:
from KDM and the note for sent notes, only the note otherwise). The bar of the block has **Yenile** (refresh from KDM),
**Takvimi aç** (open the calendar) and **Bloğu kaldır** (remove the block from the note; KDM is not touched).

### KDM calendar

Open it with the ribbon icon or **KDM takvimini aç**. Entries use KDM's colours: yellow planned, green completed, red not
completed, grey leave. Every entry has a green ✓ (mark as completed) and a red × (delete) at its bottom right. Only planned entries can be moved or resized; entries of past weeks are locked and open in a read-only view.

### Commands

| Command | What it does |
| --- | --- |
| KDM takvimini aç | Opens the weekly calendar |
| KDM'ye görev ekle | Opens the add-task dialog for today |
| Haftalık plan bloğu ekle | Inserts a plan block for a week you choose |
| Görev listesini yenile | Downloads your task list again |
| KDM'ye giriş yap / KDM'den çıkış yap | Logs in or out |
| KDM bağlantısını sına | Reads this week to check that the connection works |

### Settings

| Setting | Default |
| --- | --- |
| KDM URL | empty (enter the address of your KDM site, for example `https://kdm.example.com`) |
| Email | empty |
| Lunch break start / end | 12:30 / 13:30 |
| Break between tasks (minutes) | 15 |
| Block limit (hours) | 4 (blocks this long or longer are refused) |
| Default task length (minutes) | 60 |
| Show weekend | on |

## Privacy, network use and accounts

- **Account required.** The plugin only works with a KDM account.
- **Network.** The plugin contacts only the KDM URL you configure, using Obsidian's
  `requestUrl`: login, token refresh, reading your plan entries and task list, and creating, changing and deleting your
  plan entries when you ask it to. No other servers are contacted. There is **no telemetry**, no ads and no analytics.
- **Transport.** The KDM URL must be HTTPS (plain HTTP is accepted only for `localhost`). If you change the URL, the stored session is dropped, so tokens are never sent to another server. Logging out also asks KDM to revoke the refresh token. Requests time out after 30 seconds.
- **What is stored.** The access and refresh tokens are in Obsidian's secret storage. `data.json` holds your settings,
  your email, your name and user number as returned by KDM, and a cached copy of your task list. The password is only
  sent to KDM at login and is never stored.
- **Your vault.** The plugin only reads and writes notes that contain a `kdm-week` block, and only that block.
- **Payments.** None; the plugin is free.
- **Unofficial API.** KDM has no public API documentation. The plugin uses the same endpoints as KDM's web page, so a
  change on KDM's side can break it. Write operations act on your own plan entries with your own permissions.

## Development

```bash
npm ci
npm run dev      # watch; set OBSIDIAN_PLUGIN_DIR in .env to copy builds into a test vault
npm test         # unit tests (planning rules, note format, protocol)
npm run lint     # Obsidian's official ESLint rules
npm run build    # type check + production bundle
```

The protocol code is in `src/kdm-protocol.ts` and `src/kdm-client.ts`. A step by step user guide in Turkish is in
[docs/KULLANIM.md](docs/KULLANIM.md).

## License

[MIT](LICENSE)
