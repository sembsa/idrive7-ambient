# idrive7-ambient

Ambient light experiments for BMW iDrive 7 (MGU), installed through the
[mgu-store](https://github.com/robertnisipeanu/mgu-store).

## Ambient Probe (`sembsa_ambient_probe`)

Read-only. Opens the head unit's SOME/IP catalog and lists the ambient light
service (ComfortFunctionIuK, service `0xB512` on iDrive 8) and any interface
whose name mentions comfort / ambient / light / IuK / interior: fields with
their get / notify / SET flags and data types, and methods. **Nothing is sent
to the car.** The result is shown on screen (Next page) and written to the log.

Install: Store → Sources → add `sembsa/idrive7-ambient` on **Releases**.

Built with the app kit of
[idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
(`python3 kit/tools/build.py sembsa_ambient_probe`), released without
`node_modules/oap-sdk`: the head unit generates it from its donor.
