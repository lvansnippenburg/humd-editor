[Go to paragraph 'Links'](#links)

# Compatability
 
Here are all supported styles:
- ~~strikethrough~~.  
- subscript, zoals in H~2~O `H~2~O`  
- superscript, zoals in m^2^ `m^2^`  
- ==highlight== (not available in pandoc rendering).  
- **bold**.  
- _italics_.  

Dit is een regel met een Optie-Return.
En achter deze regel komen twee spaties en dan een return. 
En dit is de derde regel (met twee returns).

This is a new text to see what the editor does with line breaks. I will continue with this line for a while longer, and then press enter after this period.
This should now begin on a new line??


# headline

This document is here mainly to test compatibility between various markdown editors on some syntax that are important to my workflow. These items include:
- Zotero references
- Footnotes
- Comments
- Reviews[^1]
 
These are all items that are essential for me, and are not really consistently present in Markdown editors. The lack of these features is an important reason why many researchers are sticking to using tools for word-processing ^[Such as MS Word or Libre Office], even if these are not the most appropriate for the task. In this text, there are two different syntaxes used for footnotes. The first, works fine in Obsidian. The second one, which I will call "inline footnotes", seems to work in obsidian, but actually the footnote itself is not rendered.[^2] Switching to a different display will bring this back, but it is very unclear to the user what is happening.

Now let's look at Zotero references, or citations in general. This works in Obsidian by clicking Command-Shift-Z, a user configurable keyboard shortcut.  After this magic keycombo, the standard dialog from Zotero will appear (familiar from MS Word) to lookup the reference. In my current settings of Obsidian this should enter the reference as (author year, page). The standard Chicago 18^th^ edition style - which is also configurable. In markdown however it is actually a footnote, with a <!-- [{"creator":"Leo","timestamp":"2026-06-08 21:46","comment":"This is my comment"}, {"creator":"Leo","timestamp":"2026-06-09 12:12","comment":"Let's add it!"}] -->Zotero link wrapped in an HTML comment. When not in editing mode however, the reference is rendered as a footnote! Really odd.
 
## Links
- Wikilink: [[Hoogewerf Hendrix fonds]]
- Web link: [personal page](https://vansnippenburg.nl)

<!-- [{"creator":"Leo","timestamp":"2026-06-13 21:27","comment":"A non issue."}] -->

The more "standard" way of adding a Zotero reference can be used in VSCodium and VSCode [@engelsCommunitaFiammingaLivorno1993, 23]. This is the basic way of Pandoc. It has its advantages and disadvantages. For sure it is more pleasant to work with. Also interesting is that VScodium will render the bibliography as well.

[^1]: As in being able to send a document to a colleague and receive corrections and/or feedback.

[^2]: The numbering now is ok.
