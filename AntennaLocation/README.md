# Source
`standorte-mobilfunkanlagen_2056.json` (not committed) holds the locations of mobile phone antennas in Switzerland, from the Swiss Federal Office of Communications (OFCOM), layer `ch.bakom.standorte-mobilfunkanlagen` [[metadata](https://www.geocat.ch/geonetwork/srv/ger/catalog.search#/metadata/6a972f46-ae47-4db9-b5a7-dcfd3598bd95)]. Terms: open use, source must be cited.

Download it here, then run `python3 serve.py --rebuild` to rebuild `web/data/antennas.json`:

```sh
curl -L -o AntennaLocation/standorte-mobilfunkanlagen_2056.json https://data.geo.admin.ch/ch.bakom.standorte-mobilfunkanlagen/standorte-mobilfunkanlagen/standorte-mobilfunkanlagen_2056.json
```
