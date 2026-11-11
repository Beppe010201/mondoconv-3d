# Incorpora sheet-analyzer.js nello userscript (tra i marcatori).
import re
p = 'mondoconv-3d.user.js'
s = open(p).read()
a = s.index('// ===== Analisi schede tecniche =====\n') + len('// ===== Analisi schede tecniche =====\n')
b = s.index('// ===== Script principale =====')
s = s[:a] + open('sheet-analyzer.js').read() + '\n' + s[b:]
open(p, 'w').write(s)
print('incorporato')
