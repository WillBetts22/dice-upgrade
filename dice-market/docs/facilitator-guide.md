# Facilitator guide

A short guide for whoever runs the room at the event.

## Before people arrive (5 minutes)

1. Open the site on a laptop connected to the projector and choose **Host Game**. Leave test mode **off** for a real event.
2. Choose the number of rounds. Two rounds take about 25 minutes. The screen shows the projected length.
3. Keep the host tab open; it holds your host credential. Open **Projector view** in a second window and put that on the big screen. The projector view needs no login.
4. If you want to play as well, enter a name under **Play as well?** and open your player screen on your phone or in another tab. You then count toward the 30-player cap.

## While players join (the 5 minute explanation)

Players scan the QR code or go to `<site>/join/<CODE>` and enter a display name. Names must be unique within the room. Each phone remembers its player, so refreshing or reconnecting puts them back in as the same player.

Read this script, or put it in your own words:

> You each start with 100 coins and one upgrade. At the end you roll five dice and get five coins per point, with up to two upgrades changing the result. Your score is your remaining money plus the dice winnings minus any uncovered short deductions. During seven minutes, post prices to buy and sell upgrades, or accept someone else's price. You can sell something you do not have, but then you owe it. Buy it back before time runs out, or that upgrade's highest traded price this round is deducted from your final score for each unit owed. Your screen shows this exposure; you can owe at most two units in total. Check the Holdings tab to see who owns what. The host chooses the number of rounds, with two as the default. Each round has fresh money and a new fair selection of upgrades, so use the first round to learn how to price them.

Players mark themselves ready, and the host panel shows how many are ready and connected. Press **Start** when you are ready. That freezes the roster: anyone who joins later can watch but not trade.

## During a round

- **Market (7 min):** it cannot be ended early outside test mode. The host panel shows recent trades and who is short.
- **Pause** freezes the clock and blocks trading and selection. **Resume** continues with the time that was left. Use it if the Wi-Fi drops or people have questions.
- **Selection (1 min):** settlement runs automatically when the market closes. Players see a receipt of any short deductions and pick up to two upgrades. Anyone who does nothing gets the automatic choice.
- **Reveal (1 min):** everyone's dice resolve at once on the projector. Phones show each player's own dice in detail.
- **Results (1 min):** the round score, market summary and leaderboard. The next round starts automatically. Press **Start next round now** to skip the wait.

## If something goes wrong

- **A player's phone dies:** they stay in the game. Their open orders stay on the book, and they get automatic equipment and dice. When they reconnect on the same device and browser, they come back as the same player.
- **The server restarts:** all state is in the database. Timers resume from the stored deadlines, and an overdue phase finishes exactly once.
- **Someone joined twice by mistake:** in the lobby you can remove them. Once the session has started, players cannot be removed.
- **The projector browser loses its place:** reload it. It shows the same stored results.

## Talking points afterwards

- The round high rule means big trades between other players can raise your bill if you are short. That is intentional, and it is why covering early matters.
- Every upgrade is worth about 15 to 17.5 coins of extra expected dice payout on its own; see the [balance report](balance-report.md). Prices well above that are paying for the pairing, the scarcity, or the chance to squeeze a short.
- The leaderboard includes dice luck. It is not a pure skill measure.
