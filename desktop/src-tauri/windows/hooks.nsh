; Auspex Augur installer hooks (tauri.installer.conf.json: bundle.windows.nsis.installerHooks).
; After the files are copied, the installer checks for Node.js 20+ the way the
; desktop app does: AUSPEX_NODE when set, else node.exe in the first absolute
; PATH entry that has one (never the installer's own folder or the current
; directory). Node is not bundled; when it is missing or too old the installer
; says so and offers to open https://nodejs.org/. The app's Setup screen shows
; the same check. Nothing here touches the user's data in ~/.auspex, and the
; uninstaller removes the program files only.

!include LogicLib.nsh
!include WordFunc.nsh

Var AuspexNode

; Sets $AuspexNode to the node.exe the app would start, or "".
Function AuspexFindNode
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  StrCpy $AuspexNode ""
  ReadEnvStr $R0 "AUSPEX_NODE"
  ${If} $R0 != ""
    ${If} ${FileExists} "$R0"
      StrCpy $AuspexNode "$R0"
    ${EndIf}
    Goto auspex_find_done
  ${EndIf}
  ReadEnvStr $R0 "PATH"
  StrCpy $R1 1
  auspex_find_loop:
    ClearErrors
    ${WordFind} "$R0;" ";" "E+$R1" $R2
    IfErrors auspex_find_done
    ; Absolute entries only: X:\... or \\server\share\...
    StrCpy $R3 $R2 2 1
    StrCpy $R4 $R2 2
    ${If} $R3 == ":\"
    ${OrIf} $R4 == "\\"
      ${If} ${FileExists} "$R2\node.exe"
        StrCpy $AuspexNode "$R2\node.exe"
        Goto auspex_find_done
      ${EndIf}
    ${EndIf}
    IntOp $R1 $R1 + 1
    Goto auspex_find_loop
  auspex_find_done:
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Call AuspexFindNode
  StrCpy $R5 ""
  ${If} $AuspexNode == ""
    StrCpy $R5 "Node.js was not found."
  ${Else}
    ; The absolute path found above, one fixed argument.
    nsExec::ExecToStack '"$AuspexNode" --version'
    Pop $R6
    Pop $R7
    StrCpy $R8 $R7 1
    StrCpy $R7 $R7 "" 1
    IntOp $R7 $R7 + 0
    ${If} $R6 != 0
    ${OrIf} $R8 != "v"
      StrCpy $R5 "Node.js at $AuspexNode did not report its version."
    ${ElseIf} $R7 < 20
      StrCpy $R5 "Node.js $R7 at $AuspexNode is too old."
    ${EndIf}
  ${EndIf}
  ${If} $R5 != ""
    DetailPrint "Auspex Augur: $R5 Node.js 20 or newer is needed (https://nodejs.org/)."
    ${IfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "$R5$\r$\n$\r$\nAuspex Augur needs Node.js 20 or newer for its MCP server, report approvals and memory edits. The app opens without it, and its Setup screen shows the same check.$\r$\n$\r$\nOpen the Node.js download page (https://nodejs.org/) now?" IDNO auspex_node_done
      ExecShell "open" "https://nodejs.org/"
      auspex_node_done:
    ${EndIf}
  ${Else}
    DetailPrint "Auspex Augur: Node.js found at $AuspexNode."
  ${EndIf}
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
!macroend
