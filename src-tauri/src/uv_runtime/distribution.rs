//! Frozen official installation tools, separate from Agent compatibility.
//! Windows sources: 2026-10-06-product-development/windows-uv-sources.json.
pub(super) struct Distribution {
    pub url: &'static str,
    pub digest: &'static str,
    pub root: &'static str,
    pub prefix: &'static str,
    pub executable: &'static str,
}

#[cfg(not(windows))]
pub(super) const UV: Distribution = Distribution {
    url: "https://github.com/astral-sh/uv/releases/download/0.12.18/uv-aarch64-apple-darwin.tar.gz",
    digest: "cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b",
    root: "uv-0.12.18",
    prefix: "uv-aarch64-apple-darwin",
    executable: "uv",
};
#[cfg(all(windows, target_arch = "x86_64"))]
pub(super) const UV: Distribution = Distribution {
    url: "https://github.com/astral-sh/uv/releases/download/0.12.18/uv-x86_64-pc-windows-msvc.zip",
    digest: "cae6a3bc25239f83dffb467a4b180508d9da23986c04639ebfa44e43e6a84bff",
    root: "uv-0.12.18-windows-x64",
    prefix: "",
    executable: "uv.exe",
};
#[cfg(all(windows, target_arch = "aarch64"))]
pub(super) const UV: Distribution = Distribution {
    url: "https://github.com/astral-sh/uv/releases/download/0.12.18/uv-aarch64-pc-windows-msvc.zip",
    digest: "17f27b1c64eacc757ae603579f116a014881e486c5e79ae81877980d4699e943",
    root: "uv-0.12.18-windows-arm64",
    prefix: "",
    executable: "uv.exe",
};
#[cfg(not(windows))]
pub(super) const PYTHON: Distribution = Distribution {
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260807/cpython-3.12.13%2B20260807-aarch64-apple-darwin-install_only_stripped.tar.gz",
    digest: "25baa97c65b3f0aa90e21131b4f9e80aef8899e8144006db8a9d2c1ab9e807e3",
    root: "cpython-3.12.13+20260807-aarch64",
    prefix: "python",
    executable: "bin/python3.12",
};
#[cfg(all(windows, target_arch = "x86_64"))]
pub(super) const PYTHON: Distribution = Distribution {
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260807/cpython-3.12.13%2B20260807-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
    digest: "18bcc65b17921806b72cdc88bcf000bf67a2c99a8fc381fe1629f2b9ba56858d",
    root: "cpython-3.12.13+20260807-windows-x64",
    prefix: "python",
    executable: "python.exe",
};
#[cfg(all(windows, target_arch = "aarch64"))]
pub(super) const PYTHON: Distribution = Distribution {
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260807/cpython-3.12.13%2B20260807-aarch64-pc-windows-msvc-install_only_stripped.tar.gz",
    digest: "07bd1b23b9193e778a7ddb031f5dc3b12a73d47990064126d97b46fc4f64c40f",
    root: "cpython-3.12.13+20260807-windows-arm64",
    prefix: "python",
    executable: "python.exe",
};
