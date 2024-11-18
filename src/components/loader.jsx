import React from "react";
import "@/styles/css/loader/loader.css";

export default function Loader() {
    return (
        <div className="wrapper">
            <video
                autoPlay
                playsInline
                muted
                loop
                preload="auto"
                poster="http://i.imgur.com/xHO6DbC.png"
            >
                <source
                    src="https://videos.pexels.com/video-files/1893627/1893627-uhd_2560_1440_25fps.mp4"
                    type="video/mp4"
                />
                Your browser does not support the video tag.
            </video>
            <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 285 80"
                preserveAspectRatio="xMidYMid slice"
            >
                <defs>
                    <mask id="mask" x="0" y="0" width="100%" height="100%">
                        <rect
                            x="0"
                            y="0"
                            width="100%"
                            height="100%"
                            fill="white"
                        />
                        <text
                            x="72"
                            y="50"
                            fontSize="40"
                            fill="black"
                            fontFamily="Arial, sans-serif"
                        >
                            GTA VI
                        </text>
                    </mask>
                </defs>
                <rect
                    x="0"
                    y="0"
                    width="100%"
                    height="100%"
                    fill="black"
                    mask="url(#mask)"
                />
            </svg>
        </div>
    );
}
