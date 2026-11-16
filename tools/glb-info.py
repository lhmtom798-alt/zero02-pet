#!/usr/bin/env python3
"""glb-info.py — inspect .vrm / .glb files without any 3D library.

Reads the GLB container (magic / version / chunks), parses the JSON chunk and
prints a summary: asset generator, extensions (VRM / MToon / VRMC_vrm), VRM
meta (title, author, license, usage flags), node names, material names,
texture count + dimensions, mesh/vertex totals and humanoid bone count.

Also extracts embedded images (thumbnails / base-colour textures) to a folder
so they can be eyeballed, and computes a SHA-256 of the whole file.

Usage:
    python3 tools/glb-info.py models/*.vrm
    python3 tools/glb-info.py models/Seed-san.vrm --json
    python3 tools/glb-info.py models/Seed-san.vrm --extract /tmp/tex/seed
    python3 tools/glb-info.py models/            # whole directory

Only stdlib is required for the summary; Pillow is optional and used only to
print image dimensions and convert JPEG/PNG as-is.
"""

import argparse
import hashlib
import json
import os
import struct
import sys
import tempfile

GLB_MAGIC = b"glTF"
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942


class GlbError(Exception):
    pass


def read_glb(path):
    """Return (gltf_json_dict, bin_blob, file_size, sha256_hex)."""
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        head = fh.read(12)
        if len(head) < 12:
            raise GlbError("file shorter than 12-byte GLB header")
        magic, version, length = struct.unpack("<4sII", head)
        if magic != GLB_MAGIC:
            raise GlbError("bad magic %r (not a GLB: expected b'glTF')" % magic)
        if version not in (1, 2):
            raise GlbError("unsupported GLB version %d" % version)
        sha = hashlib.sha256()
        fh.seek(0)
        while True:
            block = fh.read(1 << 20)
            if not block:
                break
            sha.update(block)
        fh.seek(12)
        gltf = None
        binary = b""
        read = 12
        while read + 8 <= min(length, size):
            chunk_len, chunk_type = struct.unpack("<II", fh.read(8))
            read += 8
            data = fh.read(chunk_len)
            read += chunk_len
            if chunk_type == CHUNK_JSON:
                gltf = json.loads(data.decode("utf-8").rstrip("\x00 "))
            elif chunk_type == CHUNK_BIN:
                binary = data
            # unknown chunk types are skipped by spec
            pad = chunk_len % 4
            if pad:
                fh.seek(4 - pad, 1)
                read += 4 - pad
        if gltf is None:
            raise GlbError("no JSON chunk found")
    return gltf, binary, size, sha.hexdigest()


def accessor_count(g, idx):
    try:
        return int(g["accessors"][idx].get("count", 0))
    except (KeyError, IndexError, TypeError):
        return 0


def mesh_stats(g):
    verts = 0
    prims = 0
    tris = 0
    for mesh in g.get("meshes", []):
        for prim in mesh.get("primitives", []):
            prims += 1
            pos = prim.get("attributes", {}).get("POSITION")
            verts += accessor_count(g, pos)
            if "indices" in prim:
                tris += accessor_count(g, prim["indices"]) // 3
    return {"meshes": len(g.get("meshes", [])), "primitives": prims,
            "vertices": verts, "triangles": tris}


def vrm_meta(g):
    """Return a normalised dict describing a VRM 0.x or VRM 1.0 file."""
    ext = g.get("extensions", {}) or {}
    if "VRM" in ext:  # VRM 0.x
        v = ext["VRM"]
        meta = v.get("meta", {}) or {}
        human = v.get("humanoid", {}) or {}
        bones = (human.get("humanBones") or [])
        blend = v.get("blendShapeMaster", {}).get("blendShapeGroups") or []
        mats = v.get("materialProperties") or []
        return {
            "spec": "VRM 0.x",
            "title": meta.get("title"),
            "author": meta.get("author"),
            "contact": meta.get("contactInformation"),
            "reference": meta.get("reference"),
            "licenseName": meta.get("licenseName"),
            "licenseUrl": meta.get("otherPermissionUrl"),
            "version": meta.get("version"),
            "allowedUser": meta.get("allowedUserName"),
            "commercial": meta.get("commercialUssageName"),
            "violent": meta.get("violentUssageName"),
            "sexual": meta.get("sexualUssageName"),
            "redistribution": meta.get("redistributionName"),
            "modification": meta.get("modificationName"),
            "thumbnailImage": meta.get("thumbnailImage"),
            "licenseRestrictions": meta.get("licenseRestrictions"),
            "bones": len(bones),
            "expressions": len(blend),
            "expression_names": [b.get("name") for b in blend][:40],
            "mtoon_materials": len(mats),
        }
    if "VRMC_vrm" in ext:  # VRM 1.0
        v = ext["VRMC_vrm"]
        meta = v.get("meta", {}) or {}
        human = v.get("humanoid", {}) or {}
        bones = (human.get("humanBones") or {})
        expressions = v.get("expressions", {}) or {}
        preset = expressions.get("preset") or {}
        custom = expressions.get("custom") or {}
        return {
            "spec": "VRM 1.0",
            "title": meta.get("name"),
            "author": ", ".join(meta.get("authors") or []) or None,
            "contact": meta.get("contactInformation"),
            "reference": meta.get("references") and meta.get("references")[0],
            "licenseUrl": meta.get("licenseUrl"),
            "version": meta.get("version"),
            "allowedUser": meta.get("avatarPermission"),
            "commercial": meta.get("commercialUsage"),
            "violent": meta.get("allowExcessivelyViolentUsage"),
            "sexual": meta.get("allowExcessivelySexualUsage"),
            "redistribution": meta.get("allowRedistribution"),
            "modification": meta.get("modification"),
            "thumbnailImage": meta.get("thumbnailImage"),
            "creditNotation": meta.get("creditNotation"),
            "licenseRestrictions": meta.get("otherLicenseUrl"),
            "bones": len(bones),
            "expressions": len(preset) + len(custom),
            "expression_names": list(preset.keys())[:40],
            "mtoon_materials": len(ext.get("VRMC_materials_mtoon") and [] or []),
        }
    return None


def image_dims(blob):
    """Best-effort width/height for PNG/JPEG without Pillow."""
    try:
        if blob[:8] == b"\x89PNG\r\n\x1a\n":
            w, h = struct.unpack(">II", blob[16:24])
            return w, h
        if blob[:2] == b"\xff\xd8":  # JPEG: walk segments
            i = 2
            while i + 9 < len(blob):
                if blob[i] != 0xFF:
                    i += 1
                    continue
                marker = blob[i + 1]
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                              0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h, w = struct.unpack(">HH", blob[i + 5:i + 9])
                    return w, h
                seg = struct.unpack(">H", blob[i + 2:i + 4])[0]
                i += 2 + seg
    except Exception:
        pass
    return None


def images(g, binary):
    """Yield (index, name, mime, bytes) for every embedded image."""
    bvs = g.get("bufferViews", [])
    out = []
    for i, img in enumerate(g.get("images", [])):
        if "bufferView" not in img:
            out.append((i, img.get("name"), img.get("mimeType"), None,
                        img.get("uri")))
            continue
        bv = bvs[img["bufferView"]]
        off = int(bv.get("byteOffset", 0))
        ln = int(bv["byteLength"])
        out.append((i, img.get("name"), img.get("mimeType"), binary[off:off + ln],
                    None))
    return out


def human_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return "%.2f %s" % (n, unit) if unit != "B" else "%d B" % n
        n /= 1024.0


def summarise(path, extract=None, as_json=False):
    g, binary, size, sha = read_glb(path)
    meta = vrm_meta(g)
    mstats = mesh_stats(g)
    imgs = images(g, binary)
    img_dims = []
    for idx, name, mime, blob, uri in imgs:
        dims = image_dims(blob) if blob else None
        img_dims.append({"index": idx, "name": name, "mime": mime,
                         "dimensions": dims, "uri": uri,
                         "bytes": len(blob) if blob else None})
    ext_used = g.get("extensionsUsed") or []
    info = {
        "file": path,
        "size_bytes": size,
        "size_human": human_size(size),
        "sha256": sha,
        "glb_version": 2,
        "generator": (g.get("asset") or {}).get("generator"),
        "extensionsUsed": ext_used,
        "extensionsRequired": g.get("extensionsRequired") or [],
        "counts": {
            "nodes": len(g.get("nodes", [])),
            "meshes": mstats["meshes"],
            "primitives": mstats["primitives"],
            "vertices": mstats["vertices"],
            "triangles": mstats["triangles"],
            "materials": len(g.get("materials", [])),
            "textures": len(g.get("textures", [])),
            "images": len(g.get("images", [])),
            "animations": len(g.get("animations", [])),
            "skins": len(g.get("skins", [])),
        },
        "material_names": [m.get("name") for m in g.get("materials", [])],
        "node_names": [n.get("name") for n in g.get("nodes", [])],
        "images": img_dims,
        "vrm": meta,
    }

    if extract:
        os.makedirs(extract, exist_ok=True)
        for idx, name, mime, blob, uri in imgs:
            if not blob:
                continue
            ext = {"image/png": ".png", "image/jpeg": ".jpg",
                   "image/webp": ".webp"}.get(mime, ".bin")
            safe = "".join(c if c.isalnum() or c in "-_." else "_"
                           for c in (name or "img%02d" % idx))
            if not safe.endswith(ext):
                safe += ext
            dst = os.path.join(extract, "img%02d_%s" % (idx, safe))
            with open(dst, "wb") as fh:
                fh.write(blob)
        info["extracted_to"] = extract

    if as_json:
        print(json.dumps(info, indent=2, ensure_ascii=False))
        return info

    print("=" * 78)
    print("%s  (%s, %d bytes)" % (path, human_size(size), size))
    print("  sha256      : %s" % sha)
    print("  generator   : %s" % info["generator"])
    print("  ext used    : %s" % ", ".join(ext_used))
    req = info["extensionsRequired"]
    if req:
        print("  ext required: %s" % ", ".join(req))
    c = info["counts"]
    print("  scene       : %d nodes / %d meshes / %d verts / %d tris"
          % (c["nodes"], c["meshes"], c["vertices"], c["triangles"]))
    print("  materials   : %d (%s)" % (c["materials"], ", ".join(
        (n or "?") for n in info["material_names"][:14])))
    print("  textures    : %d images, %d textures" % (c["images"], c["textures"]))
    for im in img_dims[:12]:
        dims = im["dimensions"]
        print("      img%02d %-28s %-10s %s  %s" % (
            im["index"], (im["name"] or "?")[:28], im["mime"],
            ("%dx%d" % dims) if dims else "?",
            human_size(im["bytes"]) if im["bytes"] else im["uri"]))
    if meta:
        print("  --- VRM %s ---" % meta["spec"].split()[-1])
        for k in ("title", "author", "contact", "reference", "licenseName",
                  "licenseUrl", "version", "allowedUser", "commercial",
                  "violent", "sexual", "redistribution", "modification",
                  "creditNotation", "licenseRestrictions", "thumbnailImage"):
            if meta.get(k) not in (None, "", []):
                print("  %-12s: %s" % (k, meta[k]))
        print("  bones       : %d" % meta["bones"])
        print("  expressions : %d %s" % (
            meta["expressions"], ",".join(
                str(x) for x in meta["expression_names"][:24])))
    else:
        print("  --- no VRM extension (plain glTF/GLB) ---")
    print("  node names  : %s%s" % (
        ", ".join(str(n) for n in info["node_names"][:10]),
        " ..." if len(info["node_names"]) > 10 else ""))
    return info


def iter_targets(args):
    for target in args:
        if os.path.isdir(target):
            for root, _dirs, files in os.walk(target):
                for f in sorted(files):
                    if f.lower().endswith((".vrm", ".glb", ".gltf")):
                        yield os.path.join(root, f)
        else:
            yield target


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+", help=".vrm/.glb files or directories")
    ap.add_argument("--json", action="store_true", help="emit machine JSON")
    ap.add_argument("--extract", metavar="DIR",
                    help="write embedded images into DIR")
    ap.add_argument("--fail-fast", action="store_true")
    opts = ap.parse_args(argv)
    n_ok = n_bad = 0
    for path in iter_targets(opts.files):
        try:
            summarise(path, extract=opts.extract, as_json=opts.json)
            n_ok += 1
        except GlbError as exc:
            n_bad += 1
            print("%s: GLB ERROR: %s" % (path, exc), file=sys.stderr)
            if opts.fail_fast:
                return 2
        except Exception as exc:  # noqa: BLE001 - keep going over a batch
            n_bad += 1
            print("%s: ERROR: %s: %s" % (path, type(exc).__name__, exc),
                  file=sys.stderr)
            if opts.fail_fast:
                return 2
    if n_bad:
        print("\n%d ok, %d bad" % (n_ok, n_bad), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
