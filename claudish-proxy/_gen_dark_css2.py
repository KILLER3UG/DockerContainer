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

for match in re.finditer(r"class=\\?'([^']+)'", content):
    cls_str = match.group(1)
    for c in cls_str.split():
        if c.startswith('dark:'):
            dark_classes.add(c)

# Tailwind color mappings
TAILWIND_COLORS = {
    'slate-50': '#f8fafc', 'slate-100': '#f1f5f9', 'slate-200': '#e2e8f0',
    'slate-300': '#cbd5e1', 'slate-400': '#94a3b8', 'slate-500': '#64748b',
    'slate-600': '#475569', 'slate-700': '#334155', 'slate-800': '#1e293b',
    'slate-900': '#0f172a', 'slate-950': '#020617',
    'red-50': '#fef2f2', 'red-100': '#fee2e2', 'red-200': '#fecaca',
    'red-300': '#fca5a5', 'red-400': '#f87171', 'red-500': '#ef4444',
    'red-600': '#dc2626', 'red-700': '#b91c1c', 'red-800': '#991b1b',
    'red-900': '#7f1d1d',
    'amber-50': '#fffbeb', 'amber-100': '#fef3c7', 'amber-200': '#fde68a',
    'amber-300': '#fcd34d', 'amber-400': '#fbbf24', 'amber-500': '#f59e0b',
    'amber-600': '#d97706', 'amber-700': '#b45309', 'amber-800': '#92400e',
    'amber-900': '#78350f',
    'emerald-50': '#ecfdf5', 'emerald-100': '#d1fae5', 'emerald-200': '#a7f3d0',
    'emerald-300': '#6ee7b7', 'emerald-400': '#34d399', 'emerald-500': '#10b981',
    'emerald-600': '#059669', 'emerald-700': '#047857', 'emerald-800': '#065f46',
    'emerald-900': '#064e3b',
    'green-50': '#f0fdf4', 'green-100': '#dcfce7', 'green-200': '#bbf7d0',
    'green-300': '#86efac', 'green-400': '#4ade80', 'green-500': '#22c55e',
    'green-600': '#16a34a', 'green-700': '#15803d', 'green-800': '#166534',
    'green-900': '#14532d',
    'cyan-50': '#ecfeff', 'cyan-100': '#cffafe', 'cyan-200': '#a5f3fc',
    'cyan-300': '#67e8f9', 'cyan-400': '#22d3ee', 'cyan-500': '#06b6d4',
    'cyan-600': '#0891b2', 'cyan-700': '#0e7490', 'cyan-800': '#155e75',
    'cyan-900': '#164e63',
    'blue-50': '#eff6ff', 'blue-100': '#dbeafe', 'blue-200': '#bfdbfe',
    'blue-300': '#93c5fd', 'blue-400': '#60a5fa', 'blue-500': '#3b82f6',
    'blue-600': '#2563eb', 'blue-700': '#1d4ed8', 'blue-800': '#1e40af',
    'blue-900': '#1e3a8a',
    'indigo-50': '#eef2ff', 'indigo-100': '#e0e7ff', 'indigo-200': '#c7d2fe',
    'indigo-300': '#a5b4fc', 'indigo-400': '#818cf8', 'indigo-500': '#6366f1',
    'indigo-600': '#4f46e5', 'indigo-700': '#4338ca', 'indigo-800': '#3730a3',
    'indigo-900': '#312e81',
    'purple-50': '#faf5ff', 'purple-100': '#f3e8ff', 'purple-200': '#e9d5ff',
    'purple-300': '#d8b4fe', 'purple-400': '#c084fc', 'purple-500': '#a855f7',
    'purple-600': '#9333ea', 'purple-700': '#7e22ce', 'purple-800': '#6b21a8',
    'purple-900': '#581c87',
    'pink-50': '#fdf2f8', 'pink-100': '#fce7f3', 'pink-200': '#fbcfe8',
    'pink-300': '#f9a8d4', 'pink-400': '#f472b6', 'pink-500': '#ec4899',
    'pink-600': '#db2777', 'pink-700': '#be185d', 'pink-800': '#9d174d',
    'pink-900': '#831843',
    'orange-50': '#fff7ed', 'orange-100': '#ffedd5', 'orange-200': '#fed7aa',
    'orange-300': '#fdba74', 'orange-400': '#fb923c', 'orange-500': '#f97316',
    'orange-600': '#ea580c', 'orange-700': '#c2410c', 'orange-800': '#9a3412',
    'orange-900': '#7c2d12',
}

def parse_class(cls):
    """Parse a dark: class into (property, color, opacity, pseudo)"""
    cls = cls.replace('dark:', '')
    pseudo = None
    for p in ['hover:', 'focus:', 'active:']:
        if cls.startswith(p):
            pseudo = p[:-1]
            cls = cls[len(p):]
            break
    
    parts = cls.split('-')
    if parts[0] in ('bg', 'background'):
        prop = 'background-color'
    elif parts[0] in ('text',):
        prop = 'color'
    elif parts[0] in ('border',):
        prop = 'border-color'
    else:
        return None
    
    # Extract color and opacity
    color_key = '-'.join(parts[1:])
    opacity = None
    if '/' in color_key:
        color_key, opacity_str = color_key.split('/')
        opacity = int(opacity_str) / 100
    
    color_val = TAILWIND_COLORS.get(color_key)
    if not color_val:
        return None
    
    if opacity is not None:
        # Convert hex to rgba
        r = int(color_val[1:3], 16)
        g = int(color_val[3:5], 16)
        b = int(color_val[5:7], 16)
        color_val = f'rgba({r}, {g}, {b}, {opacity})'
    
    return prop, color_val, pseudo

lines = []
for dc in sorted(dark_classes):
    parsed = parse_class(dc)
    if not parsed:
        continue
    prop, val, pseudo = parsed
    base_cls = dc.replace('dark:', '').replace(':', '\\:').replace('/', '\\/')
    if pseudo:
        selector = f'.dark .{base_cls}:{pseudo}'
    else:
        selector = f'.dark .{base_cls}'
    lines.append(f'{selector} {{ {prop}: {val} !important; }}')

print('\\n'.join(lines))
