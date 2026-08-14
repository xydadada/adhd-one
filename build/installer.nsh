!include "LogicLib.nsh"

!macro customInstall
  nsExec::ExecToLog '"$INSTDIR\resources\tools\7za.exe" x "$INSTDIR\resources\dsh-runtime.7z" -o"$INSTDIR\resources" -y'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "DeepSeek Harness runtime extraction failed (exit code $0)."
    Abort
  ${EndIf}
  Delete "$INSTDIR\resources\dsh-runtime.7z"
  WinShell::UninstShortcut "$DESKTOP\Awesome DeepSeek Harness Desktop.lnk"
  Delete "$DESKTOP\Awesome DeepSeek Harness Desktop.lnk"
  WinShell::UninstShortcut "$SMPROGRAMS\Awesome DeepSeek Harness Desktop.lnk"
  Delete "$SMPROGRAMS\Awesome DeepSeek Harness Desktop.lnk"
!macroend
