import re

with open('ui.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Extract all dark: class variants
dark_classes = set()
for match in re.finditer(r'class="([^"]+)"', content):
    cls_str = match.group(1)
    for c in cls_str.split():
        if c.startswith('dark:'):
            dark_classes.add(c)

# Also extract from JS template strings (renderInspector, loadRequests, etc.)
for match in re.finditer(r"class=\\?'([^']+)'", content):
    cls_str = match.group(1)
    for c in cls_str.split():
        if c.startswith('dark:'):
            dark_classes.add(c)

print(f'Total dark classes found: {len(dark_classes)}')
for dc in sorted(dark_classes)[:30]:
    print(dc)
