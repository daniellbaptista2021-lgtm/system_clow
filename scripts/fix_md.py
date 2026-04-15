#!/usr/bin/env python3
"""Fix the md() markdown parser in index.html to prevent double-linking"""

import sys

html_path = sys.argv[1] if len(sys.argv) > 1 else "public/index.html"

content = open(html_path, "r").read()

idx = content.find("function md(t)")
end = content.find("function scr()", idx)

if idx < 0 or end < 0:
    print("ERROR: md() or scr() not found")
    sys.exit(1)

# Clean md() function that:
# 1. Converts code blocks first (so backticks don't interfere)
# 2. Converts markdown [text](url) to <a> tags
# 3. Does NOT auto-link bare URLs (this caused double-linking)
# 4. Properly handles bold, italic, headers, lists
new_md = (
    'function md(t){'
    'var s=String(t||"");'
    # Code blocks
    's=s.replace(/```(\\w*)\\n([\\s\\S]*?)```/g,"<pre><code>$2</code></pre>");'
    's=s.replace(/`([^`]+)`/g,"<code>$1</code>");'
    # Bold and italic
    's=s.replace(/\\*\\*(.+?)\\*\\*/g,"<strong>$1</strong>");'
    's=s.replace(/\\*(.+?)\\*/g,"<em>$1</em>");'
    # Headers
    's=s.replace(/^### (.+)$/gm,"<h4>$1</h4>");'
    's=s.replace(/^## (.+)$/gm,"<h3>$1</h3>");'
    # Lists
    's=s.replace(/^- (.+)$/gm,"\\u2022 $1");'
    # Markdown links [text](url) - ONLY this, no bare URL auto-linking
    's=s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g,'
    '\'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>\');'
    # Paragraphs and line breaks
    's=s.replace(/\\n{2,}/g,"</p><p>");'
    's=s.replace(/\\n/g,"<br>");'
    'return s}'
    '\n'
)

content = content[:idx] + new_md + content[end:]
open(html_path, "w").write(content)
print(f"OK: replaced md() function ({len(new_md)} chars)")
