# Changelog

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
