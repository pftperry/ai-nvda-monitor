# Social cards

`node tools/cards.mjs` writes three SVGs here from whatever is currently in
`web/data`. No figure is typed in, so a card cannot go stale against the site and
anyone who checks a number will find the same one.

To rasterise for platforms that will not take SVG (Twitter/X among them), serve
the repo and point headless Chrome at each file:

    cp tools/cards/*.svg web/_cards/
    chrome --headless=new --window-size=1600,900 \
      --screenshot=tools/cards/anchor-rank.png \
      http://localhost:8099/_cards/anchor-rank.svg

Cards deliberately show complete days only and pick the post-peak low, for the
same reasons `completeDays()` and the launchpad takeaway do on the site.
