const MuseBLE = require('../src/MuseBLE');
const express = require('express');
const app = express();
// app.use(express.static('public/'));
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

const http = require('http').Server(app);
const io = require('socket.io')(http);

const FREQS = [0, 4, 8, 10, 12, 23, 30, 70, 150];

const BL_UUID = '00:55:da:b7:0b:a0';

const subjs = new Map();
io.on('connection', socket => {
	const subj = new Rx.Subject();
	subj.pipe(bufferTime(1E3), filter(v => v.length > 0))
	    .subscribe(socket.emit.bind(socket, 'data'));
	
	subjs.set(socket.id, subj);
	socket.on('disconnect', _ => subjs.delete(socket.id));
});
http.listen(3000);
// ---

MuseBLE.FFT(BL_UUID).then(S => subscribe(fft => {
	for(let i = Math.round(55 / f * y.length); i < 65 / f * y.length; i++) {
		fft.spectrum[i] = 0;
	}
	let attention = 0;
	const bands = [];
	for(let i = 0; i < FREQS.length-1; i++) {
		const band = fft.spectrum.slice(
			FREQS[i] / f * fft.spectrum.length,
			FREQS[i+1] / f * fft.spectrum.length
		);
		bands.push(Math.sqrt(band.reduce((a, v) => a + v*v, 0)));
		// attention += ATTN_WEIGHTS[i] * band;
	}
	console.log(bands);
	for(const [socket_id, subj] of subjs)
		subj.next(attention);
}));