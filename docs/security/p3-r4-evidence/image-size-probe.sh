du -xk -d 3 /app/node_modules 2>/dev/null | sort -rn | head -14
echo ---
du -xsk /app /usr /var /root /tmp /home 2>/dev/null
