-- humd-editor — Server Launcher
-- Starts server.py if not already running, then opens the app in the default browser.

set projectPath to "/Users/lvansnippenburg/Ontwikkeling/humd-editor"
set serverScript to projectPath & "/server/server.py"
set serverURL to "http://localhost:8082"
set logFile to "/tmp/humd-editor-server.log"

-- Check if server is already running
set serverRunning to false
try
	do shell script "curl -sf --max-time 1 " & serverURL & "/api/settings > /dev/null"
	set serverRunning to true
end try

if not serverRunning then
	-- Launch server in the background
	do shell script "python3 " & quoted form of serverScript & " >> " & quoted form of logFile & " 2>&1 &"

	-- Poll until ready (up to 10 s)
	set ready to false
	repeat 20 times
		delay 0.5
		try
			do shell script "curl -sf --max-time 1 " & serverURL & "/api/settings > /dev/null"
			set ready to true
			exit repeat
		end try
	end repeat

	if not ready then
		display dialog "The humd-editor server did not start in time." & return & return & "Check: " & logFile buttons {"OK"} default button "OK" with icon stop
		return
	end if
end if

open location serverURL
