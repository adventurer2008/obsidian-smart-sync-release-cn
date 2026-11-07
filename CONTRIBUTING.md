# Contributing

## Where to contribute

Develop Client changes in:
https://github.com/adventurer2008/obsidian-smart-sync-client

Regional distribution repositories contain generated snapshots.
Please submit source changes to the Client repository.
Server code and deployment tools are maintained separately.

## Reporting issues

Include:
- Smart Sync and Obsidian versions
- Operating system and device
- Steps to reproduce using synthetic notes
- Expected and actual behavior

For visual issues, include the interface language, theme,
font size and viewport size. Remove personal information
from screenshots and logs.

Discuss large changes in an issue before implementation.

## Development and validation

Follow the build and test instructions in the Client README.
Run checks relevant to your change, build both regional
editions and check dependency isolation.

Use isolated test vaults and synthetic accounts.
Never commit credentials, private notes, populated vaults,
databases or private logs.

Assess Windows, macOS, Linux, Android, iOS and iPadOS.
Clearly distinguish automated checks from physical-device
testing, and state untested or inapplicable cases.

## Pull requests

Keep changes focused. Describe:
- The problem and resulting behavior
- Tests performed
- Known limitations

Record the change and requirement in CHANGELOG.md.

Preserve existing features, regional identities, encryption,
account and vault isolation, and original file modification times.

Contributions must comply with the Apache-2.0 license
and applicable dependency notices.

## Security reports

Report suspected vulnerabilities privately to:
admin@smartsync.cc

Include the affected version and a minimal synthetic reproduction.
Never send passwords, tokens, encryption passphrases,
payment details or private notes.

Please coordinate disclosure before publishing exploitable details.
