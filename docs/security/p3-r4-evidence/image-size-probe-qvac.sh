cd /app/node_modules/@qvac/llm-llamacpp/prebuilds && du -sk * | sort -rn
echo ---; ls /app/node_modules/@qvac | wc -l; du -sk /app/node_modules/@qvac/* | sort -rn | head -12
echo --- platforms across qvac:; ls -d /app/node_modules/@qvac/*/prebuilds/* | sed 's#.*/##' | sort | uniq -c
