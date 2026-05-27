import sys, anthropic

client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env

SYSTEM = """You are a copy editor for an academic historian of the early
modern era. Correct grammar, punctuation, and clarity. Preserve the
author's voice, long sentences when they work, and any deliberate
archaic or period-appropriate terminology. Use British spelling.
Return the revised text first, then a short bulleted list of
substantive changes with brief reasons."""

def proofread(text):
    msg = client.messages.create(
        model="claude-opus-4-7",
        max_tokens=4096,
        system=SYSTEM,
        messages=[{"role": "user", "content": text}],
    )
    return msg.content[0].text

if __name__ == "__main__":
    print(proofread(sys.stdin.read()))

# Usage: copy the text to clipboard then do `pbpaste | python proofread.py` 