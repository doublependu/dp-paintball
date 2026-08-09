

# From Claude

Two test flakes, both now diagnosed, neither fixed because both are outside what you asked for:

- ui-test — the scoreboard's two waitForTimeout calls should be page.waitForFunction polling for the class, so it waits for the frame rather than for milliseconds. One-line each.
- arena-test — freeze the bots for the undercroft walk, as character-test.mjs:126 already does elsewhere. It's the one suite that must run in the park, where five bots wander into the arch.


