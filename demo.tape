# payfuzz terminal demo.
#
# Records the two-column story: the naive handler creates ₹5,000 of phantom
# money (red, exit 1), the hardened handler creates ₹0 (green, exit 0).
#
# Regenerate with:  vhs demo.tape   →   docs/demo.gif
# Requires vhs (https://github.com/charmbracelet/vhs); `brew install vhs`.
#
# The ~15s SETTLE on the slow_ack_timeout scenario is real and is NOT trimmed:
# the whole point is that the handler answered after the provider retried.

Output docs/demo.gif

Set Shell bash
Set FontSize 15
Set Width 1200
Set Height 760
Set Padding 24
Set Theme "Dracula"
Set PlaybackSpeed 1.0

Hide
Type "clear"
Enter
Show

Type "bash scripts/demo.sh"
Sleep 800ms
Enter

# demo.sh boots each victim and runs the full 8-scenario suite against it.
# End to end this is ~42s (dominated by the real settle on scenario 05, twice).
Sleep 45s
Sleep 2s
