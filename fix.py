with open("scripts/e2e-aqua-mouse.sh", "r") as f:
    lines = f.readlines()
for i, line in enumerate(lines):
    if line.startswith("  node --input-type=module"):
        lines[i] = "  ( " + line
    elif line == "EOF || true\n":
        lines[i] = "EOF\n  ) || true\n"
with open("scripts/e2e-aqua-mouse.sh", "w") as f:
    f.writelines(lines)
