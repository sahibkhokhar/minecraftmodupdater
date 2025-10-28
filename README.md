## Minecraft Mod Updater (CLI)

I got tired of manually updating my mods and stuff for servers, so I made this for myself.

Search Modrinth by Minecraft version and loader, build packs, view them, check compatibility across versions, and update packs.

### Quick start
- Node.js >= 18.17
- pnpm

```bash
pnpm install
pnpm start
```

### Menu actions
- Create pack: pick name, loader (Fabric/NeoForge/Forge/Quilt), and MC version. Search and add mods; newest compatible files are downloaded. Saves metadata to `modpack.json`.
- Add mods to existing pack: search and add more; results exclude mods already present.
- View pack: list all mods in a pack.
- Check compatibility (no download): select a target MC version to see which mods are compatible/incompatible without downloading.
- Update pack: create a new pack folder for a target MC version; incompatible mods are listed and skipped.

### Pack layout
```
packs/
  <packName>-<mcVersion>-<loader>/
    mods/
      <downloaded .jar files>
    modpack.json
```

### Notes
- Uses Modrinth API v2; filters by loader and version.
- You can also choose “Choose by path...” to point at any existing `modpack.json`.