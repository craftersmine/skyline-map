"""Blog posts for skyline.codz.me/blog. Run gen.py to write blog/*.html in the project."""

DATE = '2026-11-09'
DATE_H = 'November 9, 2026'


def fig(shot, alt, cap, sizes='(min-width: 50rem) 720px, 100vw'):
    return f'''<figure class="frame">
          <img data-shot="{shot}" data-sizes="{sizes}" alt="{alt}" />
          <figcaption>{cap}</figcaption>
        </figure>'''


POSTS = [
# ------------------------------------------------------------------------------------------------
dict(
slug='cities-skylines-city-map',
title='How to turn your Cities: Skylines city into an interactive map',
short='Turn your city into an interactive map',
desc='Export your Cities: Skylines city with the CSLMapView mod and open it as a detailed, interactive map in your browser, on Windows, Mac or Linux. Step by step.',
lead='Cities: Skylines shows your city one camera angle at a time. With the CSLMapView mod and a browser you can see all of it as a proper map: every road, building and transit line, with directions and a transit diagram on top.',
shot='d-hero',
body=f'''
        <p>This guide takes a city from your save game to a map you can pan, search and plan trips on. It takes about five minutes the first time, and seconds after that.</p>

        <h2>What you need</h2>
        <ul>
          <li><b>Cities: Skylines</b> (the original game, not Cities: Skylines II).</li>
          <li><b>The CSLMapView mod</b> by gansaku, from the <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=845665815" rel="noopener">Steam Workshop</a>. It writes your city to a <code>.cslmap</code> file.</li>
          <li><b>A browser with WebGL</b>, which is any current version of Chrome, Edge, Firefox or Safari.</li>
        </ul>
        <p>The mod ships with its own viewer, CSLMapView.exe, which draws a map image from the file. Its author lists it as 64-bit Windows only. <a href="/">Skyline Map</a> reads the same file in a browser, so it also works on a Mac or Linux machine.</p>

        <h2>Step 1: export the city in game</h2>
        <ol>
          <li>Subscribe to CSLMapView on the Workshop and enable it in Content Manager.</li>
          <li>Load your city.</li>
          <li>Open the mod's options and press <b>Export</b>. The mod also has an <b>Export and launch the viewer</b> button, which opens CSLMapView.exe afterwards on Windows. You don't need it for this.</li>
        </ol>
        <p>The mod can also export every time you save the game, if you turn that on in its settings. Then your newest file is always there when you want it.</p>

        <h2>Step 2: find the file</h2>
        <p>Exports go into a folder called <code>CSLMapView</code> inside the game's install folder. On a default Steam install that is:</p>
        <ul>
          <li>Windows: <code>C:\\Program Files (x86)\\Steam\\steamapps\\common\\Cities_Skylines\\CSLMapView</code></li>
          <li>macOS: <code>~/Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView</code></li>
          <li>Linux: <code>~/.local/share/Steam/steamapps/common/Cities_Skylines/CSLMapView</code></li>
        </ul>
        <p>The file is named after your city, for example <code>Sarrant-20261107-234707.cslmap</code> when timestamps are on, or <code>.cslmap.gz</code> when compression is on. If your Steam library lives somewhere else, see <a href="/blog/where-cslmapview-saves-files">where CSLMapView saves your files</a> for a quick way to get there.</p>

        <h2>Step 3: open it in Skyline Map</h2>
        <p>Go to <a href="/">skyline.codz.me</a> and drop the file on the page, or click the drop zone and pick it. The start screen also shows the folder for your system with a button to copy the path, and the shortcut that jumps straight to it in the file picker.</p>
        {fig('e-welcome', 'The Skyline Map start screen with its drop zone', 'The start screen. Drop a .cslmap or .cslmap.gz file.', '(min-width: 50rem) 560px, 100vw')}
        <p class="note">The file is read inside your browser. It isn't uploaded anywhere, so it works the same for a city you'd rather keep to yourself.</p>
        <p>Large cities take a few seconds to build: the map draws roads, lots, buildings, water, forests and terrain from the raw data, then the transit network on top.</p>

        <h2>What you can do with it</h2>
        <h3>Read it like a real map</h3>
        <p>Roads are drawn at their true width, with highways, arterials, local streets and paths each in their own style. Zoned lots are tinted by use, with buildings inside them, and every street name is placed along the whole street rather than repeated on each piece. Station and building labels use the names you gave them in game.</p>
        {fig('d-street', 'Street-level view with buildings, lots, a roundabout with one-way arrows and named landmarks', 'Street level: lots, buildings, landmarks and one-way arrows.')}
        <h3>Tilt it, or switch styles</h3>
        <p>Right-drag to rotate and tilt. Buildings rise in 3D when the camera tilts, and the game's heightmap gives you hillshading, optional 3D terrain and a Terrain style with contour lines. There is also a Night style.</p>
        {fig('d-3d-buildings', 'Tilted 3D view of a city centre with extruded buildings, metro lines and a river', 'A city centre tilted, with 3D buildings.')}
        <h3>Plan trips</h3>
        <p>Directions work for driving, transit, walking and cycling, on your city's own road network and transit lines. How that works is in <a href="/blog/cities-skylines-route-planner">route planning in your city</a>.</p>
        <h3>See the transit network as a diagram</h3>
        <p>The Transit map button draws a metro-style diagram of your lines automatically. More in <a href="/blog/cities-skylines-transit-map">making a transit map of your city</a>.</p>
        <h3>Measure, search and share</h3>
        <p>The measure tool gives distance, area and an elevation profile. Search finds stations, roads and landmarks. You can also save the current view as a PNG.</p>

        <h2>Common questions</h2>
        <h3>Does it work with Cities: Skylines II?</h3>
        <p>No. CSLMapView is a mod for the first game, and Skyline Map reads its export format.</p>
        <h3>Do I need the mod's Windows viewer?</h3>
        <p>No. Skyline Map only needs the <code>.cslmap</code> file, so the viewer doesn't matter on a Mac or Linux machine.</p>
        <h3>The map looks out of date</h3>
        <p>An export is a snapshot. Export again after you build, or turn on export on save, and open the newest file.</p>
'''),
# ------------------------------------------------------------------------------------------------
dict(
slug='where-cslmapview-saves-files',
title='Where CSLMapView saves your .cslmap files (Windows, macOS, Linux)',
short='Where CSLMapView saves your files',
desc='The folder CSLMapView exports to on Windows, macOS and Linux, how the files are named, and the fastest way to open that folder from a file picker.',
lead='CSLMapView writes each export into a folder inside the Cities: Skylines install, which is a few levels deep on every system. Here is where to look and how to get there in a couple of keystrokes.',
shot='e-welcome',
body=f'''
        <h2>The folder</h2>
        <p>The mod saves exports to a folder named <code>CSLMapView</code> in the game's install folder, <code>steamapps/common/Cities_Skylines</code>. With Steam's default library:</p>
        <div class="table-wrap"><table>
          <thead><tr><th>System</th><th>Folder</th></tr></thead>
          <tbody>
            <tr><td>Windows</td><td><code>C:\\Program Files (x86)\\Steam\\steamapps\\common\\Cities_Skylines\\CSLMapView</code></td></tr>
            <tr><td>macOS</td><td><code>~/Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView</code></td></tr>
            <tr><td>Linux</td><td><code>~/.local/share/Steam/steamapps/common/Cities_Skylines/CSLMapView</code></td></tr>
          </tbody>
        </table></div>
        <p>On macOS, <code>~/Library</code> is hidden in Finder by default, which is why the file can seem to be missing.</p>

        <h2>If your Steam library is somewhere else</h2>
        <p>If you installed the game to another drive or library folder, let Steam find it for you:</p>
        <ol>
          <li>In Steam, right-click <b>Cities: Skylines</b> in your library.</li>
          <li>Choose <b>Manage</b>, then <b>Browse local files</b>.</li>
          <li>Open the <code>CSLMapView</code> folder.</li>
        </ol>
        <p>The mod can also be pointed at a different output folder in its settings. If you or a friend changed that, the files are wherever it was set to.</p>

        <h2>What the files are called</h2>
        <p>Each export is named after your city. With the mod's timestamp setting on, the date and time are added, so exports never overwrite each other:</p>
        <ul>
          <li><code>Sarrant.cslmap</code>, without timestamps</li>
          <li><code>Sarrant-20261107-234707.cslmap</code>, exported on 7 November 2026 at 23:47:07</li>
          <li><code>Sarrant-20261107-234707.cslmap.gz</code>, the same with compression on</li>
        </ul>
        <p>The compressed <code>.gz</code> files are much smaller. <a href="/">Skyline Map</a> opens both kinds, so there is no need to unzip them. With timestamps, sort the folder by date to find your newest one.</p>
        <p>The same folder holds the mod's Windows viewer, CSLMapView.exe, and its language folders. You can ignore those.</p>

        <h2>Jump to the folder from a file picker</h2>
        <p>You don't have to click through all those folders. Copy the path above, open the file picker (in Skyline Map, click the drop zone), then:</p>
        <ul>
          <li><b>macOS:</b> press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>G</kbd>, paste with <kbd>⌘</kbd><kbd>V</kbd> and press <kbd>Return</kbd>.</li>
          <li><b>Windows:</b> press <kbd>Alt</kbd><kbd>D</kbd> to reach the address bar, paste with <kbd>Ctrl</kbd><kbd>V</kbd> and press <kbd>Enter</kbd>.</li>
          <li><b>Linux</b> (GTK file chooser): press <kbd>Ctrl</kbd><kbd>L</kbd>, paste and press <kbd>Enter</kbd>.</li>
        </ul>
        {fig('e-welcome', 'The Skyline Map start screen with its drop zone', 'Skyline Map shows the folder for your system, with a copy button, right under the drop zone.', '(min-width: 50rem) 560px, 100vw')}

        <h2>No file in the folder?</h2>
        <ul>
          <li><b>Check the mod is enabled</b> in Content Manager, then export again from the mod's options with a city loaded.</li>
          <li><b>Check the output folder setting</b> in the mod's settings.</li>
          <li><b>Look at the log.</b> The mod writes <code>CSLMapViewMod.log</code> in the <code>Cities_Skylines</code> folder, one level up, which usually says what went wrong.</li>
        </ul>
        <p>Once you have the file, <a href="/blog/cities-skylines-city-map">here is what to do with it</a>.</p>
'''),
# ------------------------------------------------------------------------------------------------
dict(
slug='cities-skylines-transit-map',
title='Make a metro-style transit map of your Cities: Skylines city',
short='Make a metro-style transit map',
desc='Generate a schematic transit map of your Cities: Skylines metro, train, tram, ferry and bus lines automatically, in the style of the London and Seoul maps, from a CSLMapView export.',
lead='Real cities explain their transit with a diagram, not a street map. Skyline Map draws one for your Cities: Skylines network automatically, with your line names, colours and stations.',
shot='d-schem',
body=f'''
        <p>Drawing a transit diagram by hand takes hours, and it is out of date the next time you add a line. If you have a CSLMapView export, you can get one in a few seconds and come back for a new one whenever the network changes.</p>
        {fig('d-schem', 'An automatic schematic transit map of rail, metro and ferry lines', 'A diagram generated from one export: rail, metro and ferry lines.')}

        <h2>How to make one</h2>
        <ol>
          <li>Export your city with the CSLMapView mod (see <a href="/blog/cities-skylines-city-map">the full walkthrough</a>).</li>
          <li>Open the file at <a href="/">skyline.codz.me</a>.</li>
          <li>Click the <b>Transit map</b> chip at the top, or choose Transit map from the menu.</li>
        </ol>
        <p>The diagram opens over the map. Drag to pan and scroll or pinch to zoom.</p>

        <h2>What it keeps from your city</h2>
        <p>The layout is generated, but the content isn't made up. It comes from the network in your export:</p>
        <ul>
          <li><b>Station order</b> on every line, as the vehicles run it.</li>
          <li><b>Line names and colours</b> as you set them in game.</li>
          <li><b>Interchanges</b>, where lines share a station.</li>
          <li><b>Shared track</b>, drawn as parallel lines side by side instead of one line on top of another.</li>
          <li><b>Branches and loops</b>.</li>
          <li><b>Station names</b> you gave in game.</li>
        </ul>
        <p>Then the lines are straightened onto horizontal, vertical and 45° runs with even spacing between stations, the way the London and Seoul maps are drawn.</p>

        <h3>Stations that are one place on the ground</h3>
        <p>In the game, a metro station and the train station above it are separate buildings with separate stops. A good diagram shows them as one interchange. Skyline Map treats stops within 120 m of each other as one place, or within 260 m when their names match, like "Norisa Station" and "Norisa Ferry Pier". It draws them side by side with a walking-transfer link.</p>

        <h2>Using it</h2>
        <h3>Follow a line</h3>
        <p>Tap a line to highlight it and see its stops in order.</p>
        {fig('d-schem-line', 'One metro line highlighted on the schematic map with its stops listed', 'One line highlighted, with its stops.')}
        <h3>Plan from a station</h3>
        <p>Tap a station to see which lines call there, then use <b>From here</b> or <b>To here</b> to plan a journey without leaving the diagram.</p>
        {fig('d-schem-station', 'A station selected on the schematic map, with its lines and journey buttons', 'A station, its lines, and the journey buttons.')}
        <h3>See a route on the diagram</h3>
        <p>A transit route planned in Directions can be shown on the diagram as well, which makes transfers easy to follow.</p>
        {fig('d-schem-route', 'A planned journey highlighted on the schematic map', 'A journey drawn on the diagram.')}
        <h3>Filter by mode</h3>
        <p>Turn modes on and off: train, metro, monorail, tram, ferry, cable car and bus. Buses start switched off, because a city with hundreds of bus lines reads better without them, but you can turn them on. The diagram remembers your choice.</p>

        <h2>Tips for a cleaner diagram</h2>
        <ul>
          <li><b>Name your stations.</b> A station you didn't name shows no label, so a named network reads much better.</li>
          <li><b>Give lines distinct colours.</b> The diagram uses the colours from your game.</li>
          <li><b>Export again after changes.</b> The diagram is rebuilt from each file, so it never goes stale.</li>
        </ul>
        <p>Prefer the real geography? The normal map draws every line in its own colour too, with parallel lines offset so they don't hide each other, and a list of all lines with their stops.</p>
'''),
# ------------------------------------------------------------------------------------------------
dict(
slug='cities-skylines-route-planner',
title='Driving, transit, walking and cycling directions in your Cities: Skylines city',
short='Directions in your city',
desc='Plan Google Maps-style driving, public transit, walking and cycling routes on your own Cities: Skylines road and transit network, from a CSLMapView export. How it works and what it can\'t know.',
lead='Once your city is a map, the next question is how to get around it. Skyline Map plans routes on your real road network and transit lines, the way Google Maps does for a real city.',
shot='d-drive',
body=f'''
        <h2>Getting directions</h2>
        <ol>
          <li>Open your export at <a href="/">skyline.codz.me</a>.</li>
          <li>Click <b>Directions</b>, or right-click the map and choose <b>Directions from here</b> or <b>Directions to here</b>.</li>
          <li>Pick a start and an end. You can type a station, road or landmark, or click the map.</li>
          <li>Choose driving, transit, walking or cycling.</li>
        </ol>
        <p>You get alternatives where there are any, turn-by-turn steps, and pins you can drag to change the trip.</p>

        <h2>Driving</h2>
        {fig('d-drive', 'Driving directions from the airport to the city centre with three alternatives and their tolls', 'Three driving routes, each with its toll total.')}
        <p>Driving routes use the roads a car may drive on, follow their speed limits and add time at junctions: a little for going straight across, more for a left turn than a right, and most for a U-turn.</p>
        <h3>One-way streets</h3>
        <p>The export doesn't record one-way directions reliably. It marks one-way lanes, but leaves out a flag the game uses to flip a road segment's direction, so the raw data alone gets the direction right only 51–89% of the time, depending on the city. Skyline Map works the directions out from more evidence:</p>
        <ul>
          <li><b>Confirmed:</b> your buses and other vehicles drive that road that way, or junction rules lock it to such a road. These are never driven against. If no route respects them, Directions says there is no legal driving route instead of drawing a wrong one.</li>
          <li><b>Likely:</b> divided roads, where traffic keeps right. These are followed as a rule too. In the rare case where nothing else works, the route is marked with a warning at the spot where it breaks the rule.</li>
          <li><b>Uncertain:</b> only the raw value. A route can use these, but it pays a penalty.</li>
        </ul>
        <p>Checked against the routes your own transit lines take, the recovered directions come out 97–100% right on the cities we tested.</p>
        <h3>Where a trip starts</h3>
        <p>A trip starts and ends partway along the nearest road a car may use, not at the nearest junction, so the route goes round the block when it needs to. Trips don't begin in the middle of a motorway unless there is no other road nearby.</p>

        <h2>Public transit</h2>
        {fig('d-transit', 'Transit directions with two options, line pills, walking time and fares', 'Transit options with your line names, transfers, walking and fares.')}
        <p>Transit routes use your lines and stations by name. Ride times come from the speed limits of the track or road each line runs on, capped at realistic speeds for each kind of vehicle, with time for accelerating, braking and stopping at each station. Buses also lose time at junctions and in traffic.</p>
        <p>The export has no timetables, so waiting times are estimates and are labelled that way. If you set fares (see <a href="/blog/cities-skylines-tolls-and-fares">tolls and fares</a>), each option shows its price.</p>

        <h2>Walking and cycling</h2>
        {fig('d-walk', 'Walking directions along an embankment, drawn as a dotted line on the streets', 'Walking follows the real paths and pavements.')}
        <p>Walking routes follow pavements and footpaths, and stay off motorways, platforms and other places pedestrians can't go. They join the path network at the nearest point on a path, so the line doesn't cut straight across a block. If a place can only be reached by motorway, the route says so rather than drawing a path that doesn't exist.</p>
        <p>Cycling prefers bike lanes and ordinary roads, and pushes the bike along footpaths when it has to. Turn on the Cycling overlay to see the bike network.</p>

        <h2>What the export doesn't include</h2>
        <p>Some things the game knows aren't in a CSLMapView export, so no route can account for them:</p>
        <ul>
          <li>Traffic lights and turn bans, including Traffic Manager: President Edition (TM:PE) rules.</li>
          <li>Live traffic.</li>
          <li>Timetables, which is why transit waits are estimates.</li>
        </ul>
        <p>For a closer look at what is and isn't in the file, see <a href="/blog/whats-in-a-cslmapview-export">what a CSLMapView export contains</a>.</p>
'''),
# ------------------------------------------------------------------------------------------------
dict(
slug='cities-skylines-tolls-and-fares',
title='Toll roads and transit fares for your Cities: Skylines city',
short='Toll roads and transit fares',
desc='Find the toll booths in your Cities: Skylines city, see which routes pay tolls, avoid them, and set your own toll fees, transit fares, transfer rules and currency.',
lead='Toll booths and ticket prices change how a city feels to get around. Skyline Map finds the toll booths in your export and lets you set the prices yourself, so routes show what a trip would cost.',
shot='d-toll',
body=f'''
        <h2>Toll booths on the map</h2>
        <p>Toll booths in your export get a marker on the map. Click one to see which road it sits on and which roads it connects.</p>
        {fig('d-toll', 'A toll booth selected on the map with its info panel', 'A toll booth and its panel.')}

        <h2>Which routes pay a toll</h2>
        <p>A driving route is marked "This route has tolls" only when it actually drives through a booth's gate, not just because it uses a highway somewhere near one. The steps include a toll step where the gate is passed.</p>
        <p>Turn on <b>Avoid tolls</b> in the driving options to route around the gates. If there is no way around, you still get the tolled route.</p>

        <h2>Setting the prices</h2>
        <p>CSLMapView doesn't export toll fees or ticket prices, so you set them yourself. Open the menu and choose <b>Tolls, fares &amp; currency</b>.</p>
        <h3>Toll fees</h3>
        <p>Set one default fee for every booth in the city, then change it for any booth that should cost more or less. Driving routes then show the toll total, and each toll step shows its fee.</p>
        {fig('e-pricing-tolls', 'Toll editor: a city-wide default fee and every booth listed', 'A city default fee, and every booth listed.', '(min-width: 50rem) 520px, 100vw')}
        <h3>Transit fares</h3>
        <p>Set fares per mode (bus, metro, train and so on) or per line. Each fare is a base price plus optional distance surcharges, charged on the distance you actually ride.</p>
        <p>Then choose how transfers work:</p>
        <ul>
          <li><b>Pay every ride:</b> each boarding is a new fare.</li>
          <li><b>One ticket per journey:</b> one fare covers transfers.</li>
          <li><b>Distance-based:</b> the whole journey is priced on total distance, like Seoul's integrated fares.</li>
        </ul>
        <p>You can limit transfers with a time window and a maximum number of transfers.</p>
        {fig('d-pricing-fares', 'The fares editor next to the map, with transfer rules and fares per mode and per line', 'Fares per mode or per line, with transfer rules.')}
        <h3>Currency</h3>
        <p>Pick a currency or set your own symbol, where it goes and how many decimals to show. Every price in the app follows it.</p>

        <h2>Where your prices are kept</h2>
        <p>Prices are saved in your browser for each city, not in the map file. When you open a newer export of the same city, they are matched back to the same booths and lines by id, name and position, so they carry over. Prices that no longer match anything are kept, not thrown away.</p>
        <p>You can export your prices as a JSON file and import them on another computer or browser.</p>

        <h2>Where prices show up</h2>
        <ul>
          <li><b>Driving directions:</b> the toll total on each route, and the fee at each toll step.</li>
          <li><b>Transit directions:</b> the fare on each option, and a fare breakdown in the itinerary.</li>
          <li><b>Line panels:</b> the fare for that line.</li>
        </ul>
        <p>More on how routes are planned in <a href="/blog/cities-skylines-route-planner">directions in your city</a>.</p>
'''),
# ------------------------------------------------------------------------------------------------
dict(
slug='whats-in-a-cslmapview-export',
title='What a CSLMapView export contains, and what it doesn\'t',
short='What a CSLMapView export contains',
desc='A plain guide to the data in a Cities: Skylines CSLMapView .cslmap file: roads, lanes, buildings, transit, terrain and districts, plus what is missing and how Skyline Map fills the gaps.',
lead='A .cslmap file is a snapshot of your city written out by the CSLMapView mod. Knowing what is in it explains what a map made from it can show, and where it has to estimate.',
shot='d-building-asset',
body=f'''
        <p>A <code>.cslmap</code> file is XML, and <code>.cslmap.gz</code> is the same file compressed. Cities are big, so files of 10–20 MB uncompressed are normal for a developed map.</p>

        <h2>What's in it</h2>
        <h3>The road and path network</h3>
        <p>Every network segment is there: roads, highways, paths, rail and metro track, bridges and tunnels. Each one has its shape, its width, its network type, and the type's lanes with their direction, vehicle type and speed limit. Road names are included, plus any custom name you gave.</p>
        <p>Nodes (the points segments meet at) have positions and heights. They also carry an "on ground" flag, which tells a real bridge or tunnel apart from a road that only looks raised because the terrain under it is coarse.</p>
        <h3>Buildings</h3>
        <p>Every building has its position, footprint, type, and the name you gave it in game, if any. Larger assets made of several buildings, like a station with separate halls and platforms, a stadium's stands or a mall's wings, are linked together in a chain. Skyline Map follows that chain, so clicking any part selects the whole asset.</p>
        {fig('d-building-asset', 'A station made of 25 buildings, all highlighted as one asset', 'One station made of 25 buildings, selected as one asset.')}
        <h3>Transit</h3>
        <p>Each transit line has its name, type, colour and stops in order. Stations take the names you gave them.</p>
        <h3>Terrain, water and forests</h3>
        <p>The heightmap, the water surface and sea level, and a forest density grid. Hillshading, contours, 3D terrain, shorelines and woods all come from these.</p>
        <h3>Districts and parks</h3>
        <p>District and park names, each with one label point.</p>

        <h2>What isn't in it</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Missing</th><th>What Skyline Map does about it</th></tr></thead>
          <tbody>
            <tr><td>District shapes</td><td>Estimates each district's area from its label point and the transit stops that record their district. A selected district is drawn as a soft region that fades toward its neighbours, and its area is labelled as an estimate.</td></tr>
            <tr><td>Reliable one-way directions</td><td>Works them out from junctions, where your transit vehicles actually drive, and keep-right on divided roads. <a href="/blog/cities-skylines-route-planner">More on this</a>.</td></tr>
            <tr><td>Traffic lights, crossings, turn bans, TM:PE rules</td><td>Not used. Routes charge time for turns and crossroads in general instead.</td></tr>
            <tr><td>Timetables</td><td>Waits are estimated and labelled as estimates.</td></tr>
            <tr><td>Toll fees and ticket prices</td><td>You set them. <a href="/blog/cities-skylines-tolls-and-fares">See tolls and fares</a>.</td></tr>
            <tr><td>Building heights</td><td>Estimated from each building's zone and level for the 3D view.</td></tr>
          </tbody>
        </table></div>

        <h2>Why the names you give matter</h2>
        <p>The export includes the names you typed in game for stations and buildings. Those are what appear on the map, in search, on the transit diagram and in transit directions. A station you never named appears as an icon without a label, so naming the important ones makes every view clearer.</p>

        <h2>Export settings worth knowing</h2>
        <ul>
          <li><b>Compression</b> writes <code>.cslmap.gz</code>, which is much smaller and opens the same way.</li>
          <li><b>Timestamps in file names</b> keep every export instead of overwriting the last one.</li>
          <li><b>Export on save</b> writes a new file each time you save the game.</li>
          <li><b>Output folder</b> moves exports somewhere other than the default. See <a href="/blog/where-cslmapview-saves-files">where the files go</a>.</li>
        </ul>

        <h2>Is my city uploaded when I open it?</h2>
        <p>No. Skyline Map reads the file in your browser and builds the map on your computer. Nothing is sent to a server.</p>
'''),
]
