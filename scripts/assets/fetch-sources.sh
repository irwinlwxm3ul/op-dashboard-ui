#!/usr/bin/env bash
# Fetches the pinned upstream source files used by the asset pipelines into $ASSETS_DL
# (default /tmp/claude-0/assets-dl). Only git (blobless, single-commit fetches) and file copies:
# nothing downloaded is executed. Then run, in order:
#   node scripts/assets/build-characters.mjs
#   node scripts/assets/build-weapons.mjs
#   node scripts/assets/build-items.mjs
#   node scripts/assets/sync-manifest.mjs
#   node scripts/assets/verify.mjs && node scripts/assets/preview.mjs
set -euo pipefail
DL="${ASSETS_DL:-/tmp/claude-0/assets-dl}"
mkdir -p "$DL"

# repo_fetch <dir> <github owner/repo> <commit>
repo_fetch() {
  local dir="$DL/repos/$1"
  if [ ! -d "$dir/.git" ]; then
    git init -q "$dir"
    git -C "$dir" remote add origin "https://github.com/$2.git"
  fi
  git -C "$dir" fetch -q --depth 1 --filter=blob:none origin "$3"
}
# show <dir> <commit> <path> <dest>
show() {
  mkdir -p "$(dirname "$4")"
  git -C "$DL/repos/$1" show "$2:$3" > "$4"
}

# 1. Quaternius Universal Animation Library 1 + 2 (CC0) - mirror tilakpatell/tilakverse-assets
TV=8506439d6d3c4c5f9c6f1b0a9f0e2d1c3b4a5968
TV_REF=$(git ls-remote https://github.com/tilakpatell/tilakverse-assets.git HEAD | cut -f1)
repo_fetch tv tilakpatell/tilakverse-assets "$TV_REF"
show tv "$TV_REF" quaternius/universal-animation-library/Unreal-Godot/UAL1.glb "$DL/ual/UAL1.glb"
show tv "$TV_REF" quaternius/universal-animation-library-2/Unreal-Godot/UAL2.glb "$DL/ual/UAL2.glb"
show tv "$TV_REF" quaternius/universal-animation-library/License.txt "$DL/ual/License1.txt"
show tv "$TV_REF" quaternius/universal-animation-library-2/License.txt "$DL/ual/License2.txt"

# 2. Quaternius Ultimate Modular Men / Women (CC0) - mirror agentkaerf/FreeModels
FM=db3df04d1e4714298a09510b26fb6de6645138a2
repo_fetch agentkaerf_FreeModels agentkaerf/FreeModels "$FM"
git -C "$DL/repos/agentkaerf_FreeModels" -c advice.detachedHead=false checkout -q "$FM" -- \
  "Ultimate Modular Men- Feb 2022/Individual Characters/glTF" "Ultimate Modular Men- Feb 2022/License.txt" \
  "Ultimate Modular Women - April 2022/Individual Characters/glTF" "Ultimate Modular Women - April 2022/License.txt"

# 3. Quaternius Ultimate Gun Pack, Survival Pack, Toon Shooter Game Kit (CC0) and
#    Zsky Low Poly Weapons Pack V.1 (CC BY 4.0) - mirror regnaio/assets
RA=336e580f990c2efd62f640957967e874efab1226
repo_fetch regnaio_assets regnaio/assets "$RA"
UGP="quaternius/ultimategun/Ultimate Gun Pack - July 2019"
for f in Pistol_1 SubmachineGun_5 AssaultRifle2_1 Shotgun_3 SniperRifle_2 SniperRifle_3; do
  show regnaio_assets "$RA" "$UGP/FBX/$f.fbx" "$DL/ugp/$f.fbx"
done
show regnaio_assets "$RA" "$UGP/License.txt" "$DL/ugp/License.txt"
SP="quaternius/survival/Survival Pack - Sept 2020"
for f in Backpack Bandages FirstAidKit FirstAidKit_Hard Can_Red GasCan; do
  show regnaio_assets "$RA" "$SP/FBX/$f.fbx" "$DL/items/surv_$f.fbx"
done
show regnaio_assets "$RA" "$SP/License.txt" "$DL/items/License_SurvivalPack.txt"
ZW="itch/zsky2000/low-poly-weapons-pack-v1/WeaponsPack_V.1"
for f in PistolAmmo_Box AssaultRifleAmmo_Box SniperAmmo_Box ShotgunAmmo_Box; do
  show regnaio_assets "$RA" "$ZW/FBX/$f.fbx" "$DL/items/zsky_$f.fbx"
done
show regnaio_assets "$RA" "$ZW/License.txt" "$DL/items/License_Zsky.txt"
TS="quaternius/toonshootergamekit/Toon Shooter Game Kit - Dec 2022"
show regnaio_assets "$RA" "$TS/Guns/glTF/Grenade.gltf" "$DL/items/toon_Grenade.gltf"
show regnaio_assets "$RA" "$TS/Characters/glTF/Character_Soldier.gltf" "$DL/items/toon_Character_Soldier.gltf"
echo "sources ready in $DL"
