# Brand assets

```
public/assets/brand/logo.svg   <- the logo the site loads
```

That file is present, so the logo already shows on the login screen, the
sidebar, the topbar and the mobile header. Nothing else to do.

## Replacing it

Overwrite `logo.svg` with your own file and refresh. Keep the same filename and
no code changes are needed.

If you would rather use a PNG, change the first entry in `LOGO_PATHS` (see
below) to `'public/assets/brand/logo.png'`.

## One component owns the logo

`UI.logo()` in `js/ui.js` renders the whole lockup. Every screen calls that
function instead of writing its own `<img>`, so the path is defined once:

```js
var LOGO_PATHS = [
    'public/assets/brand/logo.svg',   // your file
    'assets/brand/logo.svg'           // fallback if the server root is /public
];
```

The `<img>` tries each path in order. If none load, `UI.logoFallback()` swaps in
a dashed **LOGO** box so the layout never collapses. No fake logo is generated
and no external logo URL is ever fetched.

## The lockup

```
[ logo.svg ] │ PRUWise
               AI INSURANCE NAVIGATOR
```

- a thin vertical rule separates the mark from the wordmark
- **PRU** is brand red, **Wise** follows the text colour, so it is near-black in
  light mode and near-white in dark mode
- on the red login panel both halves go white
- `UI.logo({ withText: false })` gives you the mark on its own
- `UI.logo({ subtitle: null })` drops the small uppercase line

## Sizes

The component sets a height and lets the width follow, so any aspect ratio
works. Sizes come from the `--logo-h` variable in `css/components.css`:

| Variant           | Height | Used on                     |
| ----------------- | ------ | --------------------------- |
| `logo({size:'sm'})` | 26px | sidebar, topbar, mobile header |
| `logo({size:'md'})` | 32px | default                     |
| `logo({size:'lg'})` | 42px | login red panel             |
| `logo({size:'xl'})` | 64px | large marketing headings    |

A wide horizontal logo is the safest shape.

## The white plate in dark mode

`.logo-mark` paints a small white rounded plate behind the image when dark mode
is on, and always when the logo sits on the red panel. The supplied SVG contains
dark ink that would otherwise disappear against a dark background.

A CSS filter was deliberately not used, because inverting or brightening the
image would shift the brand red. If your replacement logo is already designed
for dark backgrounds, delete the `background` and `padding` lines from
`.logo-mark` in `css/components.css`.
