"""Conservative lexical guards for model-proposed changes to user-owned state.

These reject common explicit negations, examples and cross-clause targets. They
are not a general intent classifier and cannot grant new tool permissions.
"""
import re

QUOTED = re.compile(r'```[\s\S]*?```|`[^`\n]*`|“[^”]*”|「[^」]*」|‘[^’]*’|"[^"\n]*"')
CLAUSE = re.compile(r'[\n。！？!?；;]|但是|而是|\b(?:but|and)\b|'
    r'[，,](?=\s*(?:(?:请|只|也|先|再|同时|然后)\s*)?'
    r'(?:不要|别|勿|取消|停止|暂停|继续|恢复|完成|创建|建立|忘记|遗忘|删除|更正|修改|记住))', re.I)
NEGATED = re.compile(r"不要|不必|不需要|不想|不准|不用|无需|暂不|不能|不是|并非|尚未|还没|未|别|勿|"
    r"\b(?:do\s+not|don['’]t|not|never|no)\b", re.I)
CONDITIONAL = re.compile(r'如果|假如|假设|例如|比如|举例|是否|怎么|如何|解释|说明|讨论|描述|'
    r'\b(?:if|unless|example|whether|explain|describe|discuss|how\s+to)\b', re.I)
STATUS_QUERY = re.compile(r'^\s*(?:did|has|have|is|are|was|were)\b|有没有|是不是|'
    r'了(?:吗|么|嘛|没(?:有)?)\s*$|没有\s*$', re.I)


def positive_instruction(text, pattern, *, targets=()):
    """An unquoted action and, when supplied, its target in the same clause.

    A positive verb about another object must not override an explicit refusal.
    Quoted target names remain usable; quoted action verbs are only material.
    """
    # A whole-sentence quote carries its own end punctuation, which no clause contains.
    targets = tuple(re.sub(r'^[\s。！？!?；;]+|[\s。！？!?；;]+$', '', target) if target else target
                    for target in targets)
    quoted = [(m.start(), m.end()) for m in QUOTED.finditer(text)]

    def in_quote(offset):
        return any(start <= offset < end for start, end in quoted)

    edges = [0]
    for separator in CLAUSE.finditer(text):
        if not in_quote(separator.start()):
            edges.extend((separator.start(), separator.end()))
    edges.append(len(text))
    for start, end in zip(edges[::2], edges[1::2]):
        clause = text[start:end]
        if targets and not any(target and target in clause for target in targets):
            continue
        unquoted = ''.join(' ' if in_quote(offset) else text[offset] for offset in range(start, end))
        if STATUS_QUERY.search(unquoted):
            continue
        for match in pattern.finditer(text, start, end):
            if in_quote(match.start()):
                continue
            prefix = unquoted[:match.start()-start]
            # An affirmative adverb is not the prohibition 别. Keep ambiguous
            # target-before-action wording conservative (e.g. 这部分别取消).
            if not any(target and target in prefix for target in targets):
                prefix = re.sub(r'(^|\s|请|后)分别', r'\1分开', prefix)
            if not NEGATED.search(prefix) and not CONDITIONAL.search(prefix):
                return True
    return False
