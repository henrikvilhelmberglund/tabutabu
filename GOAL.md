# Tabu tabu - MIDI to guitar tab video

- takes a MIDI file as an input, creates guitar tab video (with scrolling playhead)

- smart (when there are "power chords" even on the same channel, put on different strings)

- otherwise use MIDI channels for strings, 0: "default", 1: low e, 6: high e

- support for alternate tunings

- support for symbols like slide/bend/palm mute, tapping, pull off, vibrato

- adds tab to existing video (of guitar playing), with specified transform (eg. at top/bottom and so on, colors)

- output should be six strings, with numbers where the notes are (that says the fret number), numbers should turn bold or something when they are being played
