Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir
port = WshShell.ExpandEnvironmentStrings("%CLAUDE_ZED_SHIM_PORT%")
If Not IsNumeric(port) Then port = "8124"
WshShell.Run "node dist\cli.js serve --port " & port, 0, False