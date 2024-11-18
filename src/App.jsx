import { useState } from "react";
import reactLogo from "./assets/react.svg";
import viteLogo from "/vite.svg";
import Loader from "./components/loader";
function App() {
    const [count, setCount] = useState(0);

    return (
        <>
            <div>
                <Loader />
            </div>
        </>
    );
}

export default App;
