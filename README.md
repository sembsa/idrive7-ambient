# idrive7-ambient

Ambient light experiments for BMW iDrive 7 (MGU), installed through the
[mgu-store](https://github.com/robertnisipeanu/mgu-store).

## Ambient Probe (`sembsa_ambient_probe`)

Read-only: it subscribes and reads, and writes nothing to the car. Three views
(**Mode** button, **Next page** pages through):

- **List**: interfaces in the head unit's SOME/IP catalog about ambient /
  interior light, with get / notify / SET flags and data types.
- **Details**: the ambient fields of `0xB512`
  (`de.bmw.infotainment.misc.ComfortFunctionIuK`: ambientLightInteriorColour,
  ambientLightInteriorUserSetting, statusAmbientLightInteriorColour,
  statusAmbientLightInteriorUserSetting, statusALEV4) and `0xB09E`
  (`de.bmw.body.interiorillumination.AmbientLight`: currentInteriorLightProfile,
  brightnessAmbientLight), every struct member and enum value, wrapped.
- **Live log**: the car's notifications of statusAmbientLightInteriorColour,
  currentInteriorLightProfile and brightnessAmbientLight with a UTC time stamp
  and the profile last seen, newest first; also kept in the app's
  `data/live.log`. Change the ambient colour in the car's settings and watch
  which hue each profile gives.

Install: Store → Sources → add `sembsa/idrive7-ambient` on **Releases**.

Built with the app kit of
[idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
(`python3 kit/tools/build.py sembsa_ambient_probe`), released without
`node_modules/oap-sdk`: the head unit generates it from its donor.
