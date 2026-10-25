echo "minizip-files-in-zlib1g: $(dpkg -L zlib1g | grep -ci minizip)"
echo "-- setuid/setgid:"; find / -xdev -perm /6000 -type f 2>/dev/null
echo "-- node ldd:"; ldd /usr/local/bin/node | sed "s/(0x.*//"
echo "-- libssl/openssl pkgs:"; dpkg -l | grep -E "libssl|openssl" | cut -c1-80
echo "npm $(npm -v) node $(node -v) user $(id -un)"