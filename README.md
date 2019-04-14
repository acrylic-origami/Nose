# Nose

Informed by the wonderful [MuseJS project](https://github.com/urish/muse-js/blob/master/LICENSE), Nose is a Muse interpreter that runs on Node so that EEG signals can be used in data analysis, to control web server behavior, and stream to clients. For example, this was used to circumvent the lack of a free and authoritative Bluetooth library for Unity on Android.

## Usage

`MuseBLE` is the primary module for connecting to the Muse and decoding data. Most use cases call for `MuseBLE.raw(uuid)`. Some other functions are available:

```javascript
MuseBLE = {
	raw: function(uuid: string): [
		Promise<Array<Observable<number>>>, // one Observable per channel; Promise encapsulates the connection logic
		Promise<[main_service: noble.Service, ctrl: noble.Characteristic]> // 
	],
	send_command: function(ctrl: noble.Characteristic, cmd: string, no_response: bool = true),
	FFT: function(uuid: string, FFT_WINDOW: number = 128, EDMSE_DECAY: number = 0.2): Promise<Array<Observable<dspjs.FFT>>>, // one Observable per channel; Promise encapsulates the connection logic
}
```

### Examples

Calculate a power estimate of the brainwave signal

```javascript
const BL_UUID = '00:55:da:b7:0b:a0';
MuseBLE.FFT(BL_UUID).then(S => subscribe(fft => {
	for(let i = Math.round(55 / f * y.length); i < 65 / f * y.length; i++) {
		fft.spectrum[i] = 0;
	} // blank the 60Hz noise profile
	return fft.spectrum.reduce((acc, v) => acc + v*v, 0);
});
```