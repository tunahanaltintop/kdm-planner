# Changelog

## 1.3.1

- **KDM entries in the weekly plan block are shown in full.** Entries that are in KDM but have no note in the block (e.g. entered on KDM's web page) were small one-line chips that cut off the task name and hid the description. They are now cards like the sent notes: the description is the text, wrapped in full, and the task name is shown below it, with the same edit, complete and delete buttons.

## 1.3.0

- **Remember password** (*Parolayı hatırla*, off by default). KDM sessions run out after a while and had to be logged into again by hand. With this option on, the password is kept in Obsidian's secret storage on this device, and the plugin signs in again by itself when the session has run out: on *Yenile* in the calendar or a plan block, when sending or changing an entry, and when the vault opens. The password is stored only after KDM accepted it, is used only for the KDM URL and email it was entered for, and is deleted when the option is turned off, on logout, or when KDM refuses it. *Yeniden giriş* in the settings always asks for the password.

## 1.2.0

- **Working hours.** New settings *Mesai başlangıcı* and *Mesai bitişi* (default 08:30-17:30). The calendar spans them, and new tasks are proposed inside them. Nothing is forced: a task that starts earlier or ends later is accepted and only shows a warning. The calendar widens when a week has entries outside the working hours.
- **Show weekend off** now also hides Saturday and Sunday in the weekly plan block, not only in the calendar. Unsent notes on those days are kept and come back when the setting is turned on.

## 1.1.0

Maintenance release, no change in behaviour.

- Version bump to check that a new release reaches the Obsidian community directory and the in-app plugin browser.

## 1.0.0

First release.

- **Login.** Log in with your KDM email and password; the access and refresh tokens are kept in Obsidian's secret storage and renewed automatically, the password is never stored. Your task list is downloaded once per login and cached.
- **Weekly plan block** (`kdm-week`): a week of notes inside a note, each day split into morning and afternoon around a configurable lunch break (default 12:30-13:30). Add it for any week from the command palette or the button in the header of every note; remove a block without touching KDM.
- **Send to KDM** from every note: a quick dialog prefilled with the matching task, the note as description and a suggested free slot that never falls on the lunch break. Notes about leave are entered as a leave day.
- **KDM calendar view** that mirrors KDM's planning page (08:00-18:00, 30 minute cells): add, edit, drag to move, resize, complete and delete, with KDM's status colours. Past weeks are locked as in KDM and open in a read-only view.
- **Leave days** for whole days (08:30-17:30, 8 hours per working day, several days at once) or for some hours.
- **Your rules:** no block of 4 hours or more, a break between tasks, no overlap with leave, and the "other task" type is never created.
- **Stays in step with KDM:** entries already in KDM are shown in the planner, *Yenile* brings sent notes up to date and leaves unsent notes alone, a note moves to the right half of the day (in time order) after it is sent, and a note whose entry was deleted in KDM becomes an unsent note again.
- **Security:** the KDM URL must be HTTPS and carry no credentials; a session is bound to the URL it was created for; logging out asks KDM to revoke the refresh token; requests time out after 30 seconds; only the profile fields the plugin needs are written to `data.json`.
- **Safe note edits:** a plan block is located in the note by its content, so notes with several plan blocks (even for the same week) are never written to the wrong block.
- Deleting a sent note deletes its KDM entry first and keeps the note with a warning if KDM refuses. Every button that calls KDM is disabled while the request runs.
