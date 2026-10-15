Option Explicit
Dim shell, files, root, node, probe, command, status
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
On Error Resume Next
Set probe = shell.Exec("where.exe node.exe")
node = Trim(Split(probe.StdOut.ReadAll, vbCrLf)(0))
If Err.Number <> 0 Or node = "" Then
  MsgBox "Para abrir MCP Gemini, instala Node.js 22 o posterior desde nodejs.org. Despues vuelve a abrir este archivo.", 48, "MCP Gemini"
  WScript.Quit 1
End If
On Error GoTo 0
shell.CurrentDirectory = root
command = Chr(34) & node & Chr(34) & " " & Chr(34) & files.BuildPath(root, "gemini-gui.cjs") & Chr(34)
status = shell.Run(command, 0, True)
If status <> 0 Then
  MsgBox "No se pudo abrir MCP Gemini. Comprueba que tienes Node.js 22 o posterior. Abre iniciar-gemini.cmd para ver el detalle y volver a intentarlo.", 48, "MCP Gemini"
End If
