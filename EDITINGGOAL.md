# Editing tab (create from scratch) mode

- Same 6 strings UI

- Hover on a string, it shows a preview of the note placement (default to 16th note grid, but should be able to change with keyboard shortcut page up/page down)

- Click the string, you enter placement mode, if there was a note placed previously on the same string, reuse that value to start, otherwise start at 0, drag to the right to increment note value, drag to the left to decrement note value, drag up to increment note value in octave, drag down to decrement note value in octave

- When clicking on an existing note, enter the edit mode which also uses right/left/up/down to edit the note

- As in current mode click between notes to add pulloff/hammer on, ctrl for tap is fine, alt click to add vibrato (and dragging to the right lengthens the vibrato)

- In editing mode spacebar should play the current bar to the end, go to next beat with right, previous beat with left, if the play marker is not on the first beat of a bar, only play that beat (to make editing passages easier). This should be synced perfectly with the input audio file/video too without playback issues

- Add keys for bend (when pressed over a note, drag right to increase bend, left to decrease bend, down to release bend), and other functionality that could be useful, for example palm mute. Would be best if these worked on hover instead of having to select notes and so on

- Delete with middle click (right click can interfere with normal browser operation)

- Tools:
- - 1: Single note tool (usage stated above)
- - 2: Power chord (3) tool: As above, but should place three string power chords, eg. 0 2 2 and so on vertically, dragging should change all of the notes symmetrically, eg. 0 2 2 -> drag right -> 5 7 7. The power chord tool should support single note edits when clicking on anything but the lowest note in the power chord, so you could easily create 5 7 9 or something without having to change mode
- - 3: Power chord (2) tool: As power chord 3 but only two strings: 0 2 etc
- - 4: Chord tool: Places a chord on the root where clicked, then while holding press keyboard to change the chord shape. Drag right/left/up/down to change chord starting placement.
- - 5: Arpeggio tool: As chord tool but places arpeggios instead, eg. not at the same vertical position but instead offset either strumming downwards (ascending) or upwards (descending), right/left/up/down for starting placement, keyboard for chord shape, but also arrow keys for arpeggio length
- - 6: Sweep picking tool: Related to 5 but instead places sweep picking shapes, right/left/up/down for starting placement, keyboard for chord shape, arrow keys for sweep length, keyboard number keys for string length of the arpeggio (from 2 to 6), then two extra keys for inverting the sweep or in other words switch from starting at top to starting at bottom, also a "loop button" to toggle between looping (repeating the sweep except for the starting note), and not looping (simply sweeping from top to bottom once, or bottom to top once)
- - 7-9: Placeholders
- - 0: Selection tool: Draw a box around notes to select them, then be able to cut/copy/paste and so on

- Midi export: Should support MIDI export, bring everything (including pitch bends/vibrato etc as CCs) to a .mid file that can be used in a DAW