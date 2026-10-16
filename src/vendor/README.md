# Vendored libraries

Files here are third-party code kept in the repository so the viewer and the
desktop app work offline. They are not npm dependencies and are never fetched
at runtime. `src/viewer.js` serves them on `/vendor/<file>`;
`desktop/scripts/prepare-ui.mjs` copies this folder to `desktop/dist/vendor/`.

## 3d-force-graph 1.80.1

- File: `3d-force-graph-1.80.1.min.js` (UMD bundle, global `ForceGraph3D`;
  it includes its dependencies, among them three.js and d3-force-3d)
- Source: https://registry.npmjs.org/3d-force-graph/-/3d-force-graph-1.80.1.tgz,
  file `package/dist/3d-force-graph.min.js`
- Tarball integrity (matches the registry `dist.integrity`):
  `sha512-8+JcH/K1MkVncxthCVg1vdNY49PSUY7gPMlFzBHJD91AmofqqxZNnVo5RfY61BShwZk6koqyYK7f5hp+NT6utQ==`
- sha256 of the bundle: `13088340aad408156064fd120c3bc3a47c93a3cc45b8f132d6284b20e2223be9`
- Published 2026-09-29; vendored 2026-10-16
- License: MIT, Copyright (c) 2017 Vasco Asturiano, see
  `3d-force-graph-1.80.1.LICENSE.txt` (sha256
  `7262e566e874d1ce8cfadace01d4f635f8d704b6bdf7b4345cc028e5faeafded`)
- Homepage: https://github.com/vasturiano/3d-force-graph

To upgrade: download the new tarball from registry.npmjs.org into an empty
folder, check its integrity against `npm view 3d-force-graph@<v> dist.integrity`,
copy `dist/3d-force-graph.min.js` and `LICENSE` here under the new version,
update this file and `graph3dVendor` in `src/viewer.html`, and run `npm test`.
