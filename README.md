## Minecraft Mod Updater (CLI)

Command-line tool to search Modrinth for mods by Minecraft version and loader, download the newest compatible files into a pack folder, view packs, and perform full pack updates to a new Minecraft version.

### Requirements
- Node.js >= 18.17
- pnpm

### Install
```bash
pnpm install
```

### Run
```bash
pnpm start
```

### What it does
- Create a pack: choose a pack name, loader (Fabric/NeoForge/Forge/Quilt), and Minecraft version. Search for mods and add them; newest compatible files are downloaded into `packs/<name>-<version>-<loader>/mods`. A `modpack.json` is saved with mod metadata.
- Add mods to an existing pack: select a pack and search to add more mods. Search results automatically exclude mods already in the pack.
- View a pack: open any existing pack folder and list its mods.
- Update a pack: select a pack, choose a new Minecraft version, see which mods are incompatible, and optionally proceed. A new pack folder is created with compatible mods downloaded.

### Pack structure
```
packs/
  <packName>-<mcVersion>-<loader>/
    mods/
      <downloaded .jar files>
    modpack.json
```

### Notes
- Uses Modrinth API v2. Loader and version filters are applied when searching and when selecting the latest compatible version for each mod.
- If a mod has no compatible version, it’s listed as incompatible during update and excluded unless you cancel the update.


