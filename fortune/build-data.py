# Builds fortune/fortunes.json from the Guanyin poem data (qiantong, PyPI) + fortune/th-meanings.json.
# Usage: python -I -X utf8 fortune/build-data.py <path to guanyin.json>
import json, sys, os
src = json.load(open(sys.argv[1], encoding='utf-8'))
th = json.load(open(os.path.join(os.path.dirname(__file__), 'th-meanings.json'), encoding='utf-8'))
assert len(src) == 100 and len(th) == 100, (len(src), len(th))
out = [[s['level'][0], '，'.join(s['poem'][:2]) + '\n' + '，'.join(s['poem'][2:]), t[0], t[1]] for s, t in zip(src, th)]
json.dump(out, open(os.path.join(os.path.dirname(__file__), 'fortunes.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
print('ok', len(out))
