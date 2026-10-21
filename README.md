# TestRail Hover

View TestRail case details directly in VS Code by hovering over case IDs such as `C1849545`.

## Features

- Shows case details, preconditions, steps, expected results, and custom fields in a readable format.
- Includes a link to open the case in TestRail.
- Works across all projects available to the configured TestRail account.
- Loads shared lookup information only when needed and fetches suite metadata on demand.
- Reuses viewed cases and persisted lookup information to keep hovering fast.

## Getting started

1. Install the extension from a `.vsix` file or the VS Code Marketplace.
2. Open a code file containing a TestRail case ID.
3. Open the Command Palette with `Cmd+Shift+P`.
4. Run `TestRail Hover: Save Credentials`.
5. Enter your TestRail HTTPS base URL, username/email, and API key.
6. Hover over a case ID such as `C1849545`.

## Commands

- `TestRail Hover: Save Credentials` — save or replace the TestRail URL, username, and API key.
- `TestRail Hover: Refresh metadata` — refresh shared lookups and previously loaded suite metadata, then clear case details.
- `TestRail Hover: Clear case cache` — remove cached testcase details while keeping metadata available.
- `TestRail Hover: Delete Credentials` — remove the saved URL, username, API key, and cached data.

## Settings

Open VS Code Settings and search for `TestRail Hover`.

| Setting | Default | Description |
| --- | ---: | --- |
| `testrailHover.cacheTtlMinutes` | `1440` | How long case details are reused before they are refreshed, in minutes. |
| `testrailHover.cacheMaxEntries` | `200` | Maximum number of case details kept for quick reuse. |
| `testrailHover.persistMetadata` | `true` | Keep lookup names such as suites, sections, users, and priorities between VS Code sessions. |
| `testrailHover.requestIntervalMs` | `250` | Minimum time between TestRail requests, in milliseconds. Allowed range: `100`–`5000`. |
| `testrailHover.debugLogging` | `false` | Write metadata diagnostics to the VS Code Extension Host log for troubleshooting. |

Set `testrailHover.persistMetadata` to `false` when lookup information should not be retained between sessions.

## Privacy and security

- The API key is protected by VS Code and is never included in cached case or lookup data.
- Cached data is scoped to the configured TestRail account and base URL.
- Use a TestRail account with only the permissions required for viewing cases.

## License

MIT
