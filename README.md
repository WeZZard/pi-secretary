# pi-secretary

A personal pi coding agent extension.

> ⚠️ Work in progress. This is an empty scaffold; features are added
> incrementally.

## Install

```bash
pi install git:github.com/WeZZard/pi-secretary
```

## Package

This is a [pi package](https://pi.dev/packages) that bundles an extension under
`extensions/`.

| File | Purpose |
| --- | --- |
| `extensions/secretary/index.ts` | Extension entrypoint |

## Development

```bash
npm install
npm run check   # typecheck
```

Test the extension without installing it:

```bash
pi -e ./extensions/secretary/index.ts
```

## License

MIT
