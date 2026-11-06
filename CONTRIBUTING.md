# Contributing to dzstudio-mcp

Issues and pull requests are welcome. Questions are also welcome in
[#dzstudio on Discord](https://discord.gg/fxyev4w9yZ).

## Pull requests

- Keep a pull request to one change and say in its description what it changes for someone using the MCP server.
- The scene model applies operations exactly like dzStudio does; a change there must keep every golden example in
  `test/scene` byte-exact. Protocol behaviour follows
  [PROTOCOL.md](https://github.com/siemendev/dzstudio-collab-server/blob/main/PROTOCOL.md) — name the section a change
  implements.
- Run `npm run typecheck`, `npm run format:check` and `npm test` and say that they passed. The integration tests start
  the reference server from a checkout of
  [dzstudio-collab-server](https://github.com/siemendev/dzstudio-collab-server) (set `DZCOLLAB_SOURCE`, needs Go);
  without it they are skipped.

## Sign-off (DCO)

Contributions are accepted under the [Developer Certificate of Origin 1.1](https://developercertificate.org/): by
signing off a commit you confirm that you wrote it or otherwise have the right to submit it under the project's
license. Sign off every commit:

```bash
git commit -s -m "Answer unknown classes with box unknown"
```

which adds a line `Signed-off-by: Your Name <you@example.org>` to the message. A check on every pull request looks for
it.

## License

By contributing you agree that your contribution is licensed under the
[GNU Affero General Public License v3.0](LICENSE), like the rest of the repository.
