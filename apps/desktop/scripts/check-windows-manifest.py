"""Verify the built product has exactly one manifest with Common Controls v6.

Usage: python apps/desktop/scripts/check-windows-manifest.py <path to openlimiter-desktop.exe>
Reads PE resources directly, without launching the product or requiring an SDK.
"""
import struct
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def verify(path):
    data = Path(path).read_bytes()

    def u16(offset):
        return struct.unpack_from("<H", data, offset)[0]

    def u32(offset):
        return struct.unpack_from("<I", data, offset)[0]

    assert data[:2] == b"MZ", "not a PE executable"
    pe = u32(0x3C)
    assert data[pe:pe + 4] == b"PE\0\0", "invalid PE signature"
    optional = pe + 24
    magic = u16(optional)
    assert magic in (0x10B, 0x20B), "unsupported PE header"
    directories = optional + (112 if magic == 0x20B else 96)
    resource_rva = u32(directories + 16)
    section_table = optional + u16(pe + 20)
    sections = []
    for index in range(u16(pe + 6)):
        offset = section_table + index * 40
        sections.append((u32(offset + 12), max(u32(offset + 8), u32(offset + 16)),
                         u32(offset + 20)))

    def file_offset(rva):
        for start, size, raw in sections:
            if start <= rva < start + size:
                return raw + rva - start
        raise AssertionError(f"unmapped RVA {rva}")

    root = file_offset(resource_rva)
    manifests = []

    def visit(relative, identifiers):
        directory = root + relative
        count = u16(directory + 12) + u16(directory + 14)
        for index in range(count):
            entry = directory + 16 + index * 8
            identifier, target = u32(entry), u32(entry + 4)
            branch = identifiers + [identifier]
            if not identifiers and identifier != 24:  # RT_MANIFEST
                continue
            if target & 0x80000000:
                visit(target & 0x7FFFFFFF, branch)
            else:
                descriptor = root + target
                start, size = file_offset(u32(descriptor)), u32(descriptor + 4)
                manifests.append(data[start:start + size])

    visit(0, [])
    assert len(manifests) == 1, f"expected one RT_MANIFEST, found {len(manifests)}"
    assembly = ET.fromstring(manifests[0].rstrip(b"\0"))
    controls = [
        item for item in assembly.iter()
        if item.tag.rsplit("}", 1)[-1] == "assemblyIdentity"
        and item.get("name") == "Microsoft.Windows.Common-Controls"
    ]
    assert len(controls) == 1, f"expected one Common Controls dependency, found {len(controls)}"
    assert controls[0].get("version") == "6.0.0.0", "wrong Common Controls version"
    assert controls[0].get("publicKeyToken") == "6595b64144ccf1df"
    print(f"PASS: {path}: 1 RT_MANIFEST, 1 Common Controls v6 dependency")


if __name__ == "__main__":
    verify(sys.argv[1])
